#!/usr/bin/env node

/* ACS File Summariser
 * Main entry point
 * Copyright 2026 University of Sheffield
 */

import { RxClient } from "@amrc-factoryplus/rx-client";

import { Summarisers }  from "../lib/summarisers/index.js";
import { Dispatcher }   from "../lib/dispatcher.js";
import { Queue }        from "../lib/queue.js";
import { State }        from "../lib/state.js";
import { PendingStore } from "../lib/pending-store.js";
import { Api }          from "../lib/api.js";
import { Job }          from "../lib/job.js";
import { GIT_VERSION }  from "../lib/git-version.js";

const { env } = process;

const fplus = await new RxClient({ env }).init();
const log = fplus.debug.bound("summariser");

const PRUNE_INTERVAL = 15 * 60 * 1000;

const store = await new PendingStore({
    log,
    dir:            env.PENDING_DIR ?? "/pending",
    retention_ms:   Number(env.RETENTION_HOURS ?? 24) * 60 * 60 * 1000,
}).init();

const state = await new State({ fplus }).init();

const queue = await new Queue({
    log,
    concurrency: Number(env.MAX_CONCURRENT_JOBS ?? 1),
}).init();

const job = await new Job({
    fplus, state, store,
    scratch_dir: env.SCRATCH_DIR ?? "/scratch",
}).init();

const dispatcher = await new Dispatcher({
    fplus, state, queue,
    registry: Summarisers,
    process: (file_uuid, plugin) => job.run(file_uuid, plugin),
}).init();

const api = await new Api({
    log, store,
    port:       Number(env.API_PORT ?? 8080),
    username:   env.API_USERNAME,
    password:   env.API_PASSWORD,
}).init();

/* Pending points are re-derived from the filesystem on every prune pass
 * rather than tracked in memory, so this is safe to run on a timer with no
 * coordination with the rest of the service - same spirit as the dispatcher
 * re-deriving "what needs doing" from ConfigDB on every startup. */
const prune = () => store.prune().catch(e => log("Prune failed: %s", e));
setInterval(prune, PRUNE_INTERVAL).unref();
prune();

log("Starting File Summariser, revision %s", GIT_VERSION);
api.run();
dispatcher.run();
