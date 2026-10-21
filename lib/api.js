/*
 * ACS File Summariser
 * HTTP API polled by the dedicated acs-edge REST connection, plus a
 * discovery endpoint for admins wiring up new channels in the Manager
 * Copyright 2026 University of Sheffield
 */

import http   from "node:http";
import crypto from "node:crypto";

import { is_uuid, is_channel_id } from "./pending-store.js";

/* /v1/devices/<uuid>/channels                     -> discovery listing
 * /v1/devices/<uuid>/channels/<channel_id>         -> what a REST metric polls
 *
 * `channel_id` (not the raw group/channel names) is what goes in a metric's
 * Address: TDMS group/channel names are free-form and may contain `/` or
 * other characters unsafe in a URL path segment, so the discovery listing
 * hands out an opaque id instead of expecting admins (or this code) to
 * percent-encode arbitrary strings into a route. */
const CHANNELS_RE  = /^\/v1\/devices\/([^/]+)\/channels\/?$/;
const CHANNEL_RE   = /^\/v1\/devices\/([^/]+)\/channels\/([^/]+)\/?$/;

export class Api {
    constructor (opts) {
        this.store = opts.store;
        this.port = opts.port;
        this.username = opts.username;
        this.password = opts.password;
        this.log = opts.log ?? (() => {});

        if (!this.username || !this.password) {
            this.log("API_USERNAME/API_PASSWORD not set - the polling API "
                + "is unauthenticated. Fine for local development; set both "
                + "before exposing this to a real cluster network.");
        }

        this.server = http.createServer((req, res) => this._handle(req, res).catch(e => {
            this.log("Unhandled API error: %s", e);
            if (!res.headersSent) this._json(res, 500, { error: "internal error" });
        }));
    }

    async init () { return this; }

    run () {
        this.server.listen(this.port, () => this.log("Polling API listening on :%d", this.port));
    }

    async close () {
        await new Promise(resolve => this.server.close(resolve));
    }

    _json (res, status, body) {
        const data = JSON.stringify(body);
        res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
        res.end(data);
    }

    _authorised (req) {
        if (!this.username || !this.password) return true;

        const header = req.headers["authorization"] ?? "";
        const [scheme, encoded] = header.split(" ");
        if (scheme !== "Basic" || !encoded) return false;

        let decoded;
        try {
            decoded = Buffer.from(encoded, "base64").toString("utf8");
        } catch {
            return false;
        }
        const sep = decoded.indexOf(":");
        if (sep < 0) return false;

        const user = decoded.slice(0, sep);
        const pass = decoded.slice(sep + 1);

        /* Constant-time comparison so response timing can't be used to
         * guess the credential byte-by-byte. */
        const safe_eq = (a, b) => {
            const ab = Buffer.from(a), bb = Buffer.from(b);
            if (ab.length !== bb.length) return false;
            return crypto.timingSafeEqual(ab, bb);
        };
        return safe_eq(user, this.username) && safe_eq(pass, this.password);
    }

    async _handle (req, res) {
        if (req.method !== "GET") return this._json(res, 405, { error: "method not allowed" });

        if (!this._authorised(req)) {
            res.setHeader("WWW-Authenticate", "Basic realm=\"addon-file-summariser\"");
            return this._json(res, 401, { error: "unauthorised" });
        }

        const url = new URL(req.url, "http://localhost");

        const channel_match = url.pathname.match(CHANNEL_RE);
        if (channel_match) return this._get_channel(res, ...channel_match.slice(1));

        const list_match = url.pathname.match(CHANNELS_RE);
        if (list_match) return this._list_channels(res, list_match[1]);

        return this._json(res, 404, { error: "not found" });
    }

    async _list_channels (res, device_uuid) {
        if (!is_uuid(device_uuid)) return this._json(res, 400, { error: "invalid device_uuid" });

        const channels = await this.store.listChannels(device_uuid);
        return this._json(res, 200, channels);
    }

    async _get_channel (res, device_uuid, channel_id) {
        if (!is_uuid(device_uuid)) return this._json(res, 400, { error: "invalid device_uuid" });
        if (!is_channel_id(channel_id)) return this._json(res, 400, { error: "invalid channel id" });

        /* Always 200, even for an id this store has never seen - that's
         * just "nothing to deliver yet", not an error, and keeps the REST
         * driver's poll loop simple (a non-200 response is logged and
         * dropped rather than processed as an empty update). */
        const points = await this.store.getNewPoints(device_uuid, channel_id);
        return this._json(res, 200, points);
    }
}
