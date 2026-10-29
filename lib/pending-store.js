/*
 * ACS File Summariser
 * Local store for summary points awaiting delivery to the polling edge agent
 * Copyright 2026 University of Sheffield
 */

import crypto from "node:crypto";
import fs     from "node:fs/promises";
import path   from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_ID_RE = /^[0-9a-f]{20}$/;

/* Points are addressed by (device_uuid, group, channel) but group/channel
 * are free-form strings from the file, so are never used directly as path
 * components - they're hashed to a short, filesystem/URL-safe id instead.
 * `channel_id` is that id; it's also what the HTTP API exposes for admins
 * to put into a metric's Address, rather than the raw group/channel (which
 * might contain `/` or other characters unsafe in a URL path segment). */
function channel_id (group, channel) {
    return crypto.createHash("sha1")
        .update(`${group}\u0000${channel}`)
        .digest("hex")
        .slice(0, 20);
}

export function is_uuid (s) { return UUID_RE.test(s); }
export function is_channel_id (s) { return CHANNEL_ID_RE.test(s); }

export class PendingStore {
    constructor (opts) {
        this.dir = opts.dir;
        this.retention_ms = opts.retention_ms;
        this.log = opts.log ?? (() => {});

        /* Serialises all operations touching the same channel file, so a
         * record()/getNewPoints()/prune() for the same channel can never
         * interleave their read-modify-write. Keyed by device/channel_id. */
        this._locks = new Map();
    }

    async init () {
        await fs.mkdir(this.dir, { recursive: true });
        return this;
    }

    _device_dir (device_uuid) {
        return path.join(this.dir, device_uuid);
    }

    _paths (device_uuid, cid) {
        const base = path.join(this._device_dir(device_uuid), cid);
        return { points: `${base}.ndjson`, meta: `${base}.meta.json` };
    }

    /* Run `fn` exclusively with respect to any other operation on the same
     * channel. `fn` sees no other state - it must do its own I/O. */
    _with_lock (key, fn) {
        const prev = this._locks.get(key) ?? Promise.resolve();
        const run = prev.then(fn, fn);
        this._locks.set(key, run.catch(() => {}));
        return run;
    }

    async _read_meta (meta_path) {
        try {
            return JSON.parse(await fs.readFile(meta_path, "utf8"));
        } catch (e) {
            if (e.code === "ENOENT") return null;
            throw e;
        }
    }

    /* Record one summarised point, staging it for delivery. */
    async record (device_uuid, group, channel, timestamp_ns, value) {
        const cid = channel_id(group, channel);
        const key = `${device_uuid}/${cid}`;
        const { points, meta } = this._paths(device_uuid, cid);
        const now = new Date().toISOString();

        return this._with_lock(key, async () => {
            await fs.mkdir(this._device_dir(device_uuid), { recursive: true });

            await fs.appendFile(points,
                JSON.stringify({ t: timestamp_ns, v: value, r: Date.now() }) + "\n");

            const existing = await this._read_meta(meta);
            await fs.writeFile(meta, JSON.stringify({
                group, channel,
                first_seen:    existing?.first_seen ?? now,
                last_seen:     now,
                high_water_ns: existing?.high_water_ns ?? null,
            }));
        });
    }

    /* List channels known for a device, for the discovery endpoint. Returns
     * [] for a device with no staged data at all (nothing has gone wrong -
     * it just hasn't uploaded anything, or everything has already aged out). */
    async listChannels (device_uuid) {
        const dir = this._device_dir(device_uuid);
        let entries;
        try {
            entries = await fs.readdir(dir);
        } catch (e) {
            if (e.code === "ENOENT") return [];
            throw e;
        }

        const channels = [];
        for (const name of entries) {
            if (!name.endsWith(".meta.json")) continue;
            const cid = name.slice(0, -".meta.json".length);
            const { points, meta } = this._paths(device_uuid, cid);

            const info = await this._read_meta(meta);
            if (!info) continue;

            let pending_points = 0;
            try {
                const data = await fs.readFile(points, "utf8");
                pending_points = data ? data.trim().split("\n").length : 0;
            } catch (e) {
                if (e.code !== "ENOENT") throw e;
            }

            channels.push({
                channel_id:     cid,
                group:          info.group,
                channel:        info.channel,
                first_seen:     info.first_seen,
                last_seen:      info.last_seen,
                pending_points,
            });
        }
        return channels;
    }

    /* Points newer than the high-water mark for this channel, advancing the
     * mark to the newest timestamp returned. Safe to call repeatedly - a
     * channel with nothing new since the last call returns []. */
    async getNewPoints (device_uuid, cid) {
        const { points, meta } = this._paths(device_uuid, cid);
        const key = `${device_uuid}/${cid}`;

        return this._with_lock(key, async () => {
            const info = await this._read_meta(meta);
            if (!info) return [];

            let lines;
            try {
                lines = (await fs.readFile(points, "utf8")).trim();
            } catch (e) {
                if (e.code === "ENOENT") return [];
                throw e;
            }
            if (!lines) return [];

            const mark = info.high_water_ns == null ? null : BigInt(info.high_water_ns);
            const rows = lines.split("\n").map(l => JSON.parse(l));

            const fresh = mark == null
                ? rows
                : rows.filter(r => BigInt(r.t) > mark);
            if (fresh.length === 0) return [];

            fresh.sort((a, b) => (BigInt(a.t) < BigInt(b.t) ? -1 : BigInt(a.t) > BigInt(b.t) ? 1 : 0));

            const new_mark = fresh.reduce(
                (m, r) => (BigInt(r.t) > m ? BigInt(r.t) : m),
                mark ?? 0n);

            await fs.writeFile(meta, JSON.stringify({
                ...info,
                high_water_ns: new_mark.toString(),
            }));

            return fresh.map(r => ({ value: r.v, timestampNs: r.t }));
        });
    }

    /* Drop points older than the retention window, regardless of whether
     * they were ever polled - the window is a best-effort grace period for
     * delivery, not a guarantee. Removes empty channel/device directories
     * as they're emptied out. */
    async prune () {
        const cutoff = Date.now() - this.retention_ms;
        let devices;
        try {
            devices = await fs.readdir(this.dir);
        } catch (e) {
            if (e.code === "ENOENT") return;
            throw e;
        }

        for (const device_uuid of devices) {
            const dir = this._device_dir(device_uuid);
            const entries = await fs.readdir(dir).catch(() => []);
            const cids = entries
                .filter(n => n.endsWith(".ndjson"))
                .map(n => n.slice(0, -".ndjson".length));

            for (const cid of cids) {
                await this._prune_channel(device_uuid, cid, cutoff);
            }

            if ((await fs.readdir(dir).catch(() => [])).length === 0)
                await fs.rmdir(dir).catch(() => {});
        }
    }

    async _prune_channel (device_uuid, cid, cutoff) {
        const { points, meta } = this._paths(device_uuid, cid);
        const key = `${device_uuid}/${cid}`;

        await this._with_lock(key, async () => {
            let lines;
            try {
                lines = (await fs.readFile(points, "utf8")).trim();
            } catch (e) {
                if (e.code === "ENOENT") return;
                throw e;
            }

            const rows = lines ? lines.split("\n").map(l => JSON.parse(l)) : [];
            const kept = rows.filter(r => r.r >= cutoff);

            if (kept.length === rows.length) return;

            if (kept.length === 0) {
                await fs.unlink(points).catch(() => {});
                await fs.unlink(meta).catch(() => {});
                this.log("Pruned channel %s/%s (no points left in retention window)", device_uuid, cid);
                return;
            }

            await fs.writeFile(points, kept.map(r => JSON.stringify(r)).join("\n") + "\n");
            this.log("Pruned %d/%d point(s) from %s/%s", rows.length - kept.length, rows.length, device_uuid, cid);
        });
    }
}
