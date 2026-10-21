/*
 * ACS File Summariser
 * Per-file processing: download, summarise, write, mark done
 * Copyright 2026 University of Sheffield
 */

import fs   from "node:fs/promises";
import path from "node:path";

import { App } from "./constants.js";

export class Job {
    constructor (opts) {
        this.fplus = opts.fplus;
        this.state = opts.state;
        this.store = opts.store;
        this.scratch_dir = opts.scratch_dir;
        this.log = this.fplus.debug.bound("job");
    }

    async init () { return this; }

    /* Download, summarise and stage points for one file for delivery via
     * the polling API. `plugin` is the summariser module registered for
     * this file's class. */
    async run (file_uuid, plugin) {
        this.log("Processing %s", file_uuid);

        const scratch_path = path.join(this.scratch_dir, `${file_uuid}.tmp`);

        try {
            const config = await this.fplus.ConfigDB.get_config(App.Summary, file_uuid);
            const file_config = await this.fplus.ConfigDB.get_config(App.Config, file_uuid);
            const device_uuid = file_config?.device_uuid;

            /* Staged points are keyed by device, because that's how the
             * polling edge agent's config addresses them (one REST "device"
             * per physical machine, carrying its Instance_UUID). A file
             * with no device_uuid set has nowhere to be staged - error out
             * so the dispatcher's existing retry loop keeps retrying it
             * until the file's ACS-Files config is fixed, rather than
             * silently discarding its data. */
            if (!device_uuid)
                throw new Error(`File ${file_uuid} has no device_uuid set in its ACS-Files config`);

            await this.fplus.Files.save_file(file_uuid, scratch_path);

            let count = 0;
            for await (const row of plugin.summarise(scratch_path, config)) {
                await this.store.record(device_uuid, row.group, row.channel, row.timestamp_ns, row.value);
                count++;
            }

            await this.state.mark_done(file_uuid);
            this.log("Finished %s (%d points staged for delivery)", file_uuid, count);
        } catch (e) {
            this.log("Failed to summarise %s: %s", file_uuid, e);
            await this.state.mark_error(file_uuid, e).catch(() => {});
            throw e;
        } finally {
            await fs.rm(scratch_path, { force: true });
        }
    }
}
