# addon-file-summariser

`addon-file-summariser` is an **optional Factory+ add-on**, not part of core
ACS. It watches [ConfigDB](/docs/configDB) for files uploaded to
[ACS-Files](/docs/services/file-service.md), downsamples large data files
(e.g. TDMS waveform captures), and serves the resulting summary over HTTP so
it can be browsed in Grafana without needing to download the full file.

It does not write to InfluxDB itself. Instead, a dedicated `acs-edge`
instance (the normal Factory+ Edge Agent, using its built-in REST device
driver) polls this add-on's HTTP API and republishes the summary as ordinary
Sparkplug metrics; the Sparkplug historian then writes it to InfluxDB using
its own schema, the same as any other metric. See
[HTTP API](#http-api) below, and `docs/plans/2026-10-21-tdms-summary-edge-agent-ingestion.{md,html}`
in the `amrc-connectivity-stack` repo for the full design and the
Manager-side setup this still needs.

## Building

This directory is fully self-contained: nothing about building, testing,
or releasing it depends on the rest of the `amrc-connectivity-stack`
repo. The `@amrc-factoryplus/*` libraries it needs are vendored under
`vendor/` (see [Vendored dependencies](#vendored-dependencies)).

### Option A: `make`

```sh
cd addon-file-summariser
make                                             # build ghcr.io/amrc-factoryplus/addon-file-summariser:dev locally
make push                                        # same, but push (needs a registry you can push to)
make deploy k8s.namespace=addon-file-summariser  # push + rolling restart + tail logs
```

Override the defaults (`registry`, `tag`, `base_version`, etc. - see the
comment block at the top of the `Makefile`) with a `config.mk` file in
this directory:

```
registry=ghcr.io/<your-github-username>
tag=dev
```

For a rolling restart to actually pick up a freshly-pushed `dev` tag, set
`image.pullPolicy: Always` in your Helm values - `IfNotPresent` (the
default) won't re-pull an unchanged tag.

### Option B: `docker buildx` directly

```sh
cd addon-file-summariser
docker buildx build \
  --build-arg base_version=v4.1.0 \
  --build-arg revision="$(git rev-parse --short HEAD)" \
  -t ghcr.io/<your-registry>/addon-file-summariser:dev \
  --load .
```

Drop `--load` and add `--push` to push straight to a registry instead of
loading into your local Docker. `base_version` must match a tag that
`ghcr.io/amrc-factoryplus/acs-base-js-build` and `acs-base-js-run` already
have (see `env.BASE_JS_VERSION` in `.github/workflows/release.yml`).

### Option C: CI, via a GitHub release (this is how real releases happen)

Publish a GitHub release tagged `vX.Y.Z` in the repo. `.github/workflows/release.yml` then:

1. Builds the image and pushes
   `ghcr.io/amrc-factoryplus/addon-file-summariser:vX.Y.Z`, signed with
   cosign.
2. Packages `deploy/` as a Helm chart, versioned and app-versioned
   `X.Y.Z`, and pushes it to `oci://ghcr.io/amrc-factoryplus/charts`.

`.github/workflows/ci.yml` runs eslint, `helm lint`, and a build-only
Docker check on every PR and push to `main`.

### Vendored dependencies

`vendor/` holds full copies of the four `@amrc-factoryplus/*` packages
this service depends on: `rx-client`, `rx-util`, `service-client`,
`gssapi`. `package.json` depends on them via `file:./vendor/<name>`
rather than npm - two of the four (`rx-client`, `gssapi`) aren't published to npm at all, and the other two
have drifted from what is published (e.g. `service-client` here is
`1.6.1`, npm's latest is `2.0.0`), so vendoring sidesteps both the missing
packages and any version-drift risk. If these are published to npm later
and kept in sync, `vendor/` can be dropped in favour of ordinary npm
dependencies.

## Deploying

This chart is installed as its own Helm release, into its own namespace,
alongside an existing central AMRC Connectivity Stack (`amrc-connectivity-stack`)
deployment - it is never installed as part of the core chart.

For a copy-pasteable, end-to-end runbook (including the one-time step of
getting this add-on's core-side prerequisites into a cluster running an
older core release), see [INSTALLING.md](INSTALLING.md). The rest of this
section is the reference version of the same steps.

### Prerequisites

- A working core Factory+ deployment, reachable from wherever you install
  this chart (typically the same Kubernetes cluster). This add-on only needs
  HTTP reachability to Auth/ConfigDB/Files/Directory - it authenticates with
  a username/password (verified server-side against Kerberos by whichever
  service receives the request), so it never needs direct network access to
  the KDC itself.
- Core must already have applied
  `acs-service-setup/dumps/addon-file-summariser.yaml`. This happens
  automatically as part of core's normal `service-setup` bootstrap/upgrade
  job, regardless of whether this add-on is actually installed - see
  [Bootstrap coupling](#bootstrap-coupling). Nothing extra to do here as
  long as core is reasonably up to date.
- A Factory+ service account for this add-on, created manually by whoever
  administers the core deployment - there is no krb-keys-operator/`KerberosKey`
  involvement, this add-on's own chart only consumes a Secret with the
  resulting credentials. See [Service account](#service-account) below for
  what the account needs.
- `helm` >= 3.8 (for `oci://` chart support, if installing a published
  chart rather than a local checkout) and `kubectl` access to the cluster.

### Service account

This add-on does not provision its own Factory+ service account - create
one yourself (e.g. via `kadmin` for the Kerberos principal/password, and
`acs-admin` or direct ConfigDB/Auth calls for the identity), with:

- A Kerberos principal and password - any name you like, this add-on
  doesn't care what it's called, only that `SERVICE_USERNAME`/
  `SERVICE_PASSWORD` (see [Step by step](#step-by-step)) are valid Factory+
  credentials for it.
- A ConfigDB identity of class `e463b4ae-a322-46cc-8976-4ba76838e908`
  (`Auth.Class.CentralService`).
- Membership of group `228366d4-d95c-4d87-86ef-7edba5e065b4`
  (`Files.Requirement.SummariserServiceAccount`).

That last one is where the actual permissions come from - not from anything
you grant by hand. `acs-service-setup/dumps/addon-file-summariser.yaml` (in
the core repo) carries a `grants` block keyed by that same UUID, which the
Auth service applies to every ConfigDB identity classified under it. Adding
the account as a member is the only step needed; it then automatically has:

| Permission | On | Why this service needs it |
|---|---|---|
| `ConfigDB.Perm.ReadMembers` | `Files.FileType.TDMS` | Watches this class's membership to find new files to summarise (`lib/dispatcher.js`'s `watch_members`). |
| `ConfigDB.Perm.ReadConfig` | `Files.App.Config`, `Files.App.Summary`, `Files.App.SummaryState` | Reads a file's ACS-Files config, its summarisation settings, and its own processing state (`lib/job.js`, `lib/state.js`). |
| `ConfigDB.Perm.WriteConfig` | `Files.App.SummaryState` | Records a file as `done`/`error` once (re-)processed (`lib/state.js`) - the only object type this service ever writes to. |
| `Files.Perm.Download` | `Files.Class.File` (wildcard) | Downloads the file's content from ACS-Files to summarise it (`lib/job.js`'s `save_file`). |
| `Auth.Perm.ReadACL` | `Files.Perm.All` (wildcard) | Used internally by the vendored service-client/Auth libraries, not called directly by this add-on's own code. |

This is exactly what the `KerberosKey`'s `account:` block used to set up
automatically for you on every install/upgrade (it only ever added the
*classification*, the same single step above - the grants themselves have
always come from the bootstrap dump, not the chart). That automation is
gone, so classifying the account is now a one-time manual step per install,
not something `helm upgrade` repeats for you.

### Step by step

1. Create a namespace for this add-on (any name - there's no
   krb-keys-operator namespace-watch requirement to satisfy):

   ```sh
   kubectl create namespace addon-file-summariser
   ```

2. Create the polling API's Basic-auth credentials. This isn't
   Factory+-mediated, so this is a manual step:

   ```sh
   kubectl -n addon-file-summariser create secret generic file-summariser-api-auth \
     --from-literal=username=edge-agent \
     --from-literal=password="$(openssl rand -base64 24)"
   ```

   Keep the password - you'll need it again when configuring the REST
   connection in the Manager.

3. Create the service account's credentials Secret, using the
   username/password of the Factory+ service account you created per
   [Service account](#service-account) above:

   ```sh
   kubectl -n addon-file-summariser create secret generic file-summariser-service-auth \
     --from-literal=username=<the account's principal> \
     --from-literal=password=<the account's password>
   ```

4. Install the chart. From a local checkout:

   ```sh
   helm install addon-file-summariser ./deploy \
     --namespace addon-file-summariser \
     --set factoryPlus.directoryUrl=http://directory.<core-namespace>.svc.cluster.local
   ```

   Or, once a release has been published (see [Building](#building) above),
   straight from the OCI registry without a local checkout:

   ```sh
   helm install addon-file-summariser \
     oci://ghcr.io/amrc-factoryplus/charts/addon-file-summariser \
     --version X.Y.Z \
     --namespace addon-file-summariser \
     --set factoryPlus.directoryUrl=... \
     # ...same values as above
   ```

   For anything beyond a quick test, copy `deploy/values.yaml` to a file,
   fill in the `factoryPlus`/`api` sections, and pass it with
   `helm install ... -f my-values.yaml` instead of a wall of `--set` flags.

5. Verify:

   ```sh
   kubectl -n addon-file-summariser get pods
   kubectl -n addon-file-summariser logs deploy/file-summariser
   ```

   A healthy pod logs `Starting File Summariser, revision <sha>` and then
   sits idle until a file matching a watched `File_Type` (currently just
   `Files.FileType.TDMS`) is uploaded via ACS-Files.

### Values reference

| Value | Meaning | Required |
|---|---|---|
| `factoryPlus.directoryUrl` | URL of the central Directory service. The only hardcoded Factory+ coordinate - everything else is discovered from here. | yes |
| `factoryPlus.credentialsSecret.name` | Name of the Secret holding this service's Factory+ credentials, under keys `username`/`password` (must already exist in this namespace - see [Service account](#service-account) and step 3 above). No operator involvement - this is exactly whatever credentials you created the account with. | no - default `file-summariser-service-auth` |
| `api.port` | Port the polling HTTP API listens on. | no - default `8080` |
| `api.authSecret.name` | Name of the Secret holding the polling API's Basic-auth credentials, under keys `username`/`password` (must already exist in this namespace - see step 2 above). | no - default `file-summariser-api-auth` |
| `retentionHours` | How long a staged point is kept before being pruned if it's never successfully polled. | no - default `24` |
| `pendingSize` | Size of the PVC holding points staged for delivery. | no - default `2Gi` |
| `pendingStorageClass` | Storage class for that PVC. | no - default: cluster default |
| `image.registry` / `image.repository` / `image.tag` | Where to pull the container image from. `tag` defaults to the chart's `appVersion`. | no |
| `maxConcurrentJobs`, `scratchSize`, `nodeMaxOldSpaceSizeMb`, `verbosity`, `resources` | Tuning - see `deploy/values.yaml` for defaults, and [Memory and CPU safety](#memory-and-cpu-safety) below before raising `maxConcurrentJobs`. | no |

### Upgrading

```sh
helm upgrade addon-file-summariser ./deploy \
  --namespace addon-file-summariser \
  --reuse-values \
  --set image.tag=X.Y.Z
```

### Uninstalling

```sh
helm uninstall addon-file-summariser --namespace addon-file-summariser
kubectl delete namespace addon-file-summariser
```

Deleting the namespace removes the `file-summariser-service-auth` Secret you
created, but **not** the Factory+ service account itself - that lives
centrally in ConfigDB/Auth, not in this Kubernetes namespace, so you need to
remove it yourself (the reverse of [Service account](#service-account)) if
it's no longer wanted. Uninstalling the chart only removes this add-on's own
resources - it never touches core, and doesn't roll back the small
ConfigDB/Auth objects core's bootstrap created (harmless to leave in place if
you reinstall later - see [Bootstrap coupling](#bootstrap-coupling)).

The credential itself is a password you choose, stored in plaintext in a k8s
Secret (`file-summariser-service-auth`) you create and manage yourself - the
same exposure level as any other Secret in the cluster, including the keytab
this used to be (also just as readable by anyone with Secret access), not a
new class of risk, but worth stating since it's a readable password rather
than an opaque keytab blob.

## How it works

1. It subscribes to ConfigDB's notify interface and watches the members of every registered `File_Type` class (currently just `Files.FileType.TDMS`).
2. For each file it hasn't already summarised, it reads that file's per-object configuration from the `Files.App.Summary` ConfigDB Application (UUID `d34ff2d4-61ce-4488-b74c-81b1bbb7abac`), e.g.:
   ```json
   { "n": 1000 }
   ```
   If no configuration is set, the summariser plugin's own default is used (`n: 1000` for TDMS).
3. It downloads the file from ACS-Files to a local scratch directory (streamed to disk, never buffered in memory).
4. It hands the file to the summariser plugin registered for that file's type, which parses it and yields downsampled rows without holding the whole file - or the whole summary - in memory at once.
5. Each row is staged in a local pending-points store (see [HTTP API](#http-api)), keyed by the file's `device_uuid` (from its ACS-Files config) and the row's group/channel. A file with no `device_uuid` set fails and is retried - see [Retries](#retries).
6. Once a file is fully summarised, that fact is recorded durably in ConfigDB (`Files.App.SummaryState`), and the scratch copy is deleted. If processing fails, the scratch copy is still deleted and the file is retried periodically.

Because it re-derives "what needs doing" from ConfigDB on every startup, restarting the service is always safe - it just re-checks every registered file's state rather than tracking progress in memory. (Staged-but-undelivered points live on their own PVC rather than in memory for the same reason - see [HTTP API](#http-api).)

## HTTP API

Served on `api.port` (default `8080`), with HTTP Basic auth (`API_USERNAME`/`API_PASSWORD`). Meant to be reached by one thing: a dedicated `acs-edge` instance's REST device connection, polling it on a timer and republishing what it gets back as Sparkplug metrics - see
`docs/plans/2026-10-21-tdms-summary-edge-agent-ingestion.{md,html}` in the `amrc-connectivity-stack` repo for the full design, including why delivery works this way and how to configure the polling side in the Manager.

- `GET /v1/devices/<device_uuid>/channels` - discovery listing, for an admin wiring up a new device/channel in the Manager, not meant to be polled on a schedule:
  ```json
  [
    { "channel_id": "a1b2c3d4e5f6a7b8c9d0", "group": "Log", "channel": "Acc1_X",
      "first_seen": "2026-10-21T09:00:00.000Z", "last_seen": "2026-10-21T09:05:00.000Z",
      "pending_points": 1400 }
  ]
  ```
  `channel_id` is a stable hash of `group`+`channel`, not the raw names - TDMS group/channel names are free-form and may contain characters unsafe in a URL path, so this is what goes in a metric's Address, not the names themselves.
- `GET /v1/devices/<device_uuid>/channels/<channel_id>` - what a REST metric's Address points at. Returns points newer than this endpoint's own high-water mark for that channel (advanced on every successful call), so steady-state polling after the first successful delivery returns nothing new rather than replaying the whole backlog:
  ```json
  [ { "value": 0.1234, "timestampNs": "1771660800123456789" } ]
  ```
  This shape matches `acs-edge`'s REST driver's `"JSON (Batched)"` payload format exactly (`value` + `timestampNs`), including the nanosecond-string convention - see [Timestamp precision](#timestamp-precision). Always returns `200` with `[]` rather than `404` for a device/channel with nothing pending, so the edge agent's poll loop (which treats a non-`200` as an error, not an empty update) stays simple.
- Points are kept, and re-served to every poll, until `retentionHours` (default `24`) after they were staged - not after their own (possibly much older) sample timestamp. This is a grace period for the polling side being temporarily unavailable, not a delivery guarantee: InfluxDB overwrites by exact timestamp, so re-delivering something already ingested is wasted work, not corruption, but something that is never polled within the window is dropped, silently, when it ages out.

### What the TDMS summariser stages

Downsampled numeric time-series only. The TDMS plugin (`lib/summarisers/tdms.js` + `lib/summarisers/tdms_summarise.py`) summarises sampled signals and leaves everything else in the original file, which stays available from ACS-Files.

### Downsampling

`n` (from `Files.App.Summary`, default `1000`) is a **step**, not a target point count: for each channel, the samples at index `0, n, 2n, 3n, …` are kept and everything in between is dropped. No averaging or min/max is applied - each staged point is a real sample from the file. For example, a 51.2 kHz channel with `n: 1000` gives one point roughly every 19.5 ms.

### What a row looks like

A summariser plugin yields `{ group, channel, value, timestamp_ns }` rows (see [Extending to a new file type](#extending-to-a-new-file-type)). For TDMS, `group`/`channel` are the TDMS group/channel names (e.g. `Log`/`Acc1_X`) - once delivered via the polling edge agent, these become the Sparkplug `path` tag and metric name respectively, so the channel ends up queryable through `acs-data-access` as `<group>/<channel>` (e.g. `Log/Acc1_X`), the same as any other Sparkplug metric. `value` is always a float, and `timestamp_ns` is `wf_start_time` + `wf_start_offset` + index × `wf_increment`, in nanoseconds.

TDMS group and channel names are free-form. A channel name containing `/`, or one ending in `:i`, `:u`, `:d`, `:b` or `:s`, will collide with the Sparkplug path/type-suffix convention and be mis-parsed by `acs-data-access` queries once published, the same way such a Sparkplug metric name would be - this add-on's own HTTP API sidesteps the `/`-in-a-URL version of this problem by addressing channels with an opaque `channel_id` rather than the raw names (see [HTTP API](#http-api)), but the underlying Sparkplug-naming collision still applies downstream.

Channel units aren't extracted from the file, so there's currently no way to populate the Sparkplug `unit` tag for TDMS channels.

### What is summarised and what is skipped

| TDMS data | Summarised? | Notes |
|---|---|---|
| Channels with waveform timing (`wf_start_time` and `wf_increment` properties) holding floating-point or integer data | Yes | Integers are converted to float. |
| Waveform channels holding booleans (e.g. digital lines) | Yes | Staged as `1.0` / `0.0`. |
| Channels **without** waveform timing | No - whole channel skipped | These aren't sampled signals and have no time base. Typically event logs (e.g. FlexLogger's `Test Information/Events` + `Events_time`), lookup/calibration tables, or result values. |
| Channels holding text, timestamps or complex numbers | No - whole channel skipped | Not numeric time-series data. |
| Individual `NaN` / `±Infinity` samples | No - that sample skipped | Not representable as a Sparkplug float value. The rest of the channel is still staged. |
| File, group and channel properties (operator, run number, product name, units, etc.) | No | Only used internally for timing; never staged. |

## Memory and CPU safety

This service is intentionally conservative, since it runs centrally rather than one instance per edge site, and the files it handles can be tens of gigabytes:

- Only one file is processed at a time by default (`MAX_CONCURRENT_JOBS=1`). Raise this only after confirming the resource limits below can absorb it.
- Files are streamed to a scratch volume on disk, never read into Node's memory as a whole.
- The TDMS plugin reads the file one on-disk data chunk at a time (via nptdms' `data_chunks()`, see `lib/summarisers/tdms_summarise.py`) rather than loading a whole channel into memory, decoding each chunk once and sharing it across every channel in it, and streams its output to Node as NDJSON line-by-line rather than building the full summary in memory before returning it.
- The container has `resources.requests`/`limits` and `NODE_OPTIONS=--max-old-space-size` set in the Helm chart - see `deploy/values.yaml`.

See [Known limitations](#known-limitations) for the one case where the memory bound above doesn't hold.

## Extending to a new file type

Nothing outside `lib/summarisers/` is specific to TDMS. To add support for a new file type:

1. Register a new `File_Type` class in ConfigDB bootstrap (see how `Files.FileType.TDMS` is set up in `acs-service-setup/dumps/addon-file-summariser.yaml` in the core repo), and grant this service's service account `ConfigDB.Perm.ReadMembers` on it.
2. Add a plugin module under `lib/summarisers/`, exporting:
   - `defaultConfig` - the configuration to use when a file has none set in `Files.App.Summary`.
   - `async function* summarise(filePath, config)` - an async generator that reads `filePath` (already downloaded to local disk) and yields plain row objects: `{ group, channel, value, timestamp_ns }`. `timestamp_ns` should be a pre-formatted nanosecond epoch string (see [Timestamp precision](#timestamp-precision) below for why).
3. Add one line to `lib/summarisers/index.js` mapping the new class UUID to the plugin.

The dispatcher, queue, state tracking and pending-points store are all file-type-agnostic and need no changes.

## Configuration

Standard Factory+ service client variables are read from the environment by `@amrc-factoryplus/service-client` (`DIRECTORY_URL`, `SERVICE_USERNAME`, `SERVICE_PASSWORD`, `VERBOSE`, etc.) - see the [service client documentation](vendor/service-client). In addition:

| Variable             | Meaning                                                                    | Default        |
|----------------------|-----------------------------------------------------------------------------|----------------|
| `PENDING_DIR`        | Local directory used to stage summarised points awaiting delivery. Must be a real persistent volume, not an `emptyDir` - see [HTTP API](#http-api). | `/pending` |
| `RETENTION_HOURS`    | How long a staged point is kept before being pruned if it's never successfully polled. | `24` |
| `API_PORT`           | Port the HTTP API listens on.                                                | `8080`         |
| `API_USERNAME` / `API_PASSWORD` | Basic-auth credentials the polling API requires. Unset means the API is unauthenticated - fine for local development, not for a real deployment. | *(none)* |
| `SCRATCH_DIR`        | Local directory used to hold a file while it's being summarised.            | `/scratch`     |
| `MAX_CONCURRENT_JOBS`| Number of files to summarise at once.                                       | `1`            |
| `PYTHON_BIN`         | Path to the Python interpreter used to run summariser scripts (e.g. the TDMS plugin). | `/opt/venv/bin/python3` |

## ConfigDB objects

| UUID                                   | Name                        | Purpose                                                                 |
|-----------------------------------------|-----------------------------|--------------------------------------------------------------------------|
| `d34ff2d4-61ce-4488-b74c-81b1bbb7abac`  | `Files.App.Summary`          | Per-file, admin-editable summarisation config (e.g. `{"n": 1000}`).      |
| `439444d4-b0a5-45f8-ab0f-9bc41574ffa3`  | `Files.App.SummaryState`     | Internal, owned solely by this service - per-file `done`/`error` status. |
| `55d5807d-3ee7-4f0a-97a1-fd2b6458ff2f`  | `Files.FileType.TDMS`        | The `File_Type` class this service currently watches.                   |
| `228366d4-d95c-4d87-86ef-7edba5e065b4`  | `Files.Requirement.SummariserServiceAccount` | This service's own ConfigDB/Auth service role.           |

These are also defined in `lib/constants.js` for use by the service itself, and in `acs-service-setup/lib/uuids.js` / `acs-service-setup/dumps/addon-file-summariser.yaml` (in the core `amrc-connectivity-stack` repo) for cluster bootstrap.

## Bootstrap coupling

Unlike everything else in this add-on, its ConfigDB/Auth objects (the table
above) cannot be created by this add-on's own Helm chart. Both ConfigDB's
and Auth's `/load` endpoints are deliberately admin-only - there is no
"create only under objects you already own" delegation model - so a
service account scoped to this add-on can't self-register its own role and
grants. Core's `acs-service-setup` still owns applying
`acs-service-setup/dumps/addon-file-summariser.yaml`, as a small, isolated,
purely-additive dump file.

This add-on's own service account's identity is a separate, further manual
step - see [Service account](#service-account) - since there's no
krb-keys-operator automating it per-install. Everything else (the
Deployment, the namespace) is entirely this add-on's own concern.

## Retries

`watch_members` only re-emits when a class's membership actually changes, so a file whose summarisation failed (corrupt data, a transient download error, a file with no `device_uuid` set, etc.) wouldn't otherwise be retried until some other file was added to the same class. To avoid that, the dispatcher also re-checks all members on a jittered timer (every ~5 minutes) regardless of whether membership changed, and re-queues anything not marked `done`. There's no separate backoff counter - a permanently-broken file is simply retried on this same interval indefinitely, with its last error visible in `Files.App.SummaryState`.

This is also how a file with no `device_uuid` in its ACS-Files config behaves: it errors rather than being silently staged with no device to attach it to, and keeps retrying on this same interval - fixing the file's config (rather than anything in this service) is what makes it succeed.

## Timestamp precision

Nanosecond epoch timestamps (~1.7×10^18) exceed what a JSON number / JS `Number` can represent exactly (`Number.MAX_SAFE_INTEGER` is ~9×10^15). To avoid silently corrupting timestamps:

- The TDMS Python script computes timestamps as arbitrary-precision Python integers and emits them as **strings** in its NDJSON output.
- `lib/pending-store.js` keeps that string as-is end to end - staged on disk as a JSON string, and returned by the HTTP API as `timestampNs`, a string, rather than round-tripping it through a floating-point `Number`. `acs-edge`'s REST driver does the equivalent on the way back in (`BigInt(item.timestampNs)`).

Any new plugin should follow the same convention.

## Known limitations

- **nptdms only exposes microsecond precision for a channel's absolute start time** (`wf_start_time`), even though the TDMS format and `wf_increment` support finer resolution. Only the absolute start reference is limited to microseconds - this is a limitation of the `nptdms` library, not of this service.
- **`wf_increment` is rounded to a whole nanosecond**, and timestamps are computed as start + index × that rounded increment, so for sample rates whose period isn't a whole number of nanoseconds the error grows along the channel. E.g. at 51.2 kHz the true period is 19531.25 ns, written as 19531 ns, so timestamps drift 0.25 ns per sample - about 0.36 ms by the end of a 1.4 M-sample channel. Rates like 10 kHz or 50 kHz are exact.
- **Numeric data timed by a separate channel is skipped.** Some TDMS files store irregularly-sampled data as a value channel plus a separate timestamp channel (e.g. `Pressure` + `Time`) instead of using waveform timing. Neither channel has `wf_start_time`/`wf_increment`, so both are skipped - see [What is summarised and what is skipped](#what-is-summarised-and-what-is-skipped).
- **The bounded-memory read only holds if the source TDMS file is written in multiple reasonably-sized segments**, which is how real acquisition hardware streams data to disk. A pathological TDMS file written as a single giant segment can cause `nptdms` to do more work decoding a chunk internally; this was tested and doesn't reintroduce the original full-file-in-memory problem for realistic files, but it's worth knowing about if a summarisation job for a specific file is unexpectedly slow or memory-hungry.
- There's no schema validation on `Files.App.Summary` config values (e.g. a non-numeric `n`).


