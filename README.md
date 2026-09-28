# addon-file-summariser

`addon-file-summariser` is an **optional Factory+ add-on**, not part of core
ACS. It watches [ConfigDB](/docs/configDB) for files uploaded to
[ACS-Files](/docs/services/file-service.md), downsamples large data files
(e.g. TDMS waveform captures), and writes the resulting summary into
InfluxDB so it can be browsed in Grafana without needing to download the
full file.

It has no HTTP API; it is a pure reactive worker.

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
  this chart (typically the same Kubernetes cluster - InfluxDB access in
  particular is a raw in-cluster URL today, not Factory+-mediated).
- Core must already have applied
  `acs-service-setup/dumps/addon-file-summariser.yaml`. This happens
  automatically as part of core's normal `service-setup` bootstrap/upgrade
  job, regardless of whether this add-on is actually installed - see
  [Bootstrap coupling](#bootstrap-coupling). Nothing extra to do here as
  long as core is reasonably up to date.
- `helm` >= 3.8 (for `oci://` chart support, if installing a published
  chart rather than a local checkout) and `kubectl` access to the cluster.

### Step by step

1. Create a namespace named `addon-<something>`. The krb-keys-operator's
   default watch pattern only auto-picks-up `addon-*` namespaces - use a
   different name and you'll need to add it to core's
   `identity.krbKeysOperator.namespaces` value yourself:

   ```sh
   kubectl create namespace addon-file-summariser
   ```

2. Copy the InfluxDB token into the new namespace. InfluxDB access isn't
   Factory+-mediated yet, so this is a manual step:

   ```sh
   kubectl -n <core-namespace> get secret influxdb-auth -o json \
     | jq 'del(.metadata) | .metadata.name="influxdb-auth"' \
     | kubectl -n addon-file-summariser apply -f -
   ```

3. Install the chart. From a local checkout:

   ```sh
   helm install addon-file-summariser ./deploy \
     --namespace addon-file-summariser \
     --set factoryPlus.directoryUrl=http://directory.<core-namespace>.svc.cluster.local \
     --set factoryPlus.realm=FACTORYPLUS.MYORGANISATION.COM \
     --set factoryPlus.baseUrl=factoryplus.myorganisation.com \
     --set factoryPlus.coreNamespace=<core-namespace> \
     --set influx.url=http://acs-influxdb2.<core-namespace>.svc.cluster.local
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
   fill in the `factoryPlus`/`influx` sections, and pass it with
   `helm install ... -f my-values.yaml` instead of a wall of `--set` flags.

4. Verify:

   ```sh
   kubectl -n addon-file-summariser get pods
   kubectl -n addon-file-summariser get krb sv1filesummariser
   kubectl -n addon-file-summariser logs deploy/file-summariser
   ```

   A healthy pod logs `Starting File Summariser, revision <sha>` and then
   sits idle until a file matching a watched `File_Type` (currently just
   `Files.FileType.TDMS`) is uploaded via ACS-Files.

### Values reference

| Value | Meaning | Required |
|---|---|---|
| `factoryPlus.directoryUrl` | URL of the central Directory service. The only hardcoded Factory+ coordinate - everything else is discovered from here. | yes |
| `factoryPlus.realm` | Kerberos realm of the central deployment. | yes |
| `factoryPlus.baseUrl` | Base URL the central deployment is served from (used in krb5.conf). | yes |
| `factoryPlus.coreNamespace` | Namespace core's Identity component (KDC/kadmin) runs in. | yes |
| `influx.url` | URL of the central InfluxDB server. | yes |
| `influx.org` / `influx.bucket` | InfluxDB org/bucket to write to. | no - default `default`/`default` |
| `influx.tokenSecret.name` / `.key` | Secret/key holding the InfluxDB token (must already exist in this namespace - see step 2 above). | no - defaults to `influxdb-auth`/`admin-token` |
| `image.registry` / `image.repository` / `image.tag` | Where to pull the container image from. `tag` defaults to the chart's `appVersion`. | no |
| `maxConcurrentJobs`, `batchSize`, `flushInterval`, `scratchSize`, `nodeMaxOldSpaceSizeMb`, `verbosity`, `resources` | Tuning - see `deploy/values.yaml` for defaults, and [Memory and CPU safety](#memory-and-cpu-safety) below before raising `maxConcurrentJobs`. | no |

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

Deleting the namespace also removes the `KerberosKey` and its keytab
Secret. Uninstalling only removes this add-on's own resources - it never
touches core, and doesn't roll back the small ConfigDB/Auth objects core's
bootstrap created (harmless to leave in place if you reinstall later - see
[Bootstrap coupling](#bootstrap-coupling)).

## How it works

1. It subscribes to ConfigDB's notify interface and watches the members of every registered `File_Type` class (currently just `Files.FileType.TDMS`).
2. For each file it hasn't already summarised, it reads that file's per-object configuration from the `Files.App.Summary` ConfigDB Application (UUID `d34ff2d4-61ce-4488-b74c-81b1bbb7abac`), e.g.:
   ```json
   { "n": 1000 }
   ```
   If no configuration is set, the summariser plugin's own default is used (`n: 1000` for TDMS).
3. It downloads the file from ACS-Files to a local scratch directory (streamed to disk, never buffered in memory).
4. It hands the file to the summariser plugin registered for that file's type, which parses it and yields downsampled rows without holding the whole file - or the whole summary - in memory at once.
5. Rows are batched and written to InfluxDB.
6. Once a file is fully summarised, that fact is recorded durably in ConfigDB (`Files.App.SummaryState`), and the scratch copy is deleted. If processing fails, the scratch copy is still deleted and the file is retried periodically (see [Retries](#retries)).

Because it re-derives "what needs doing" from ConfigDB on every startup, restarting the service is always safe - it just re-checks every registered file's state rather than tracking progress in memory or on local disk.

## Memory and CPU safety

This service is intentionally conservative, since it runs centrally rather than one instance per edge site, and the files it handles can be tens of gigabytes:

- Only one file is processed at a time by default (`MAX_CONCURRENT_JOBS=1`). Raise this only after confirming the resource limits below can absorb it.
- Files are streamed to a scratch volume on disk, never read into Node's memory as a whole.
- The TDMS plugin parses the file in bounded windows (1,000,000 samples at a time per channel, see `lib/summarisers/tdms_summarise.py`) rather than loading a whole channel into memory, and streams its output to Node as NDJSON line-by-line rather than building the full summary in memory before returning it.
- The container has `resources.requests`/`limits` and `NODE_OPTIONS=--max-old-space-size` set in the Helm chart - see `deploy/values.yaml`.

See [Known limitations](#known-limitations) for the one case where the memory bound above doesn't hold.

## Extending to a new file type

Nothing outside `lib/summarisers/` is specific to TDMS. To add support for a new file type:

1. Register a new `File_Type` class in ConfigDB bootstrap (see how `Files.FileType.TDMS` is set up in `acs-service-setup/dumps/addon-file-summariser.yaml` in the core repo), and grant this service's service account `ConfigDB.Perm.ReadMembers` on it.
2. Add a plugin module under `lib/summarisers/`, exporting:
   - `defaultConfig` - the configuration to use when a file has none set in `Files.App.Summary`.
   - `async function* summarise(filePath, config)` - an async generator that reads `filePath` (already downloaded to local disk) and yields plain row objects: `{ measurement, tags, fields, timestamp }`. `timestamp` should be a pre-formatted nanosecond epoch string (see [Timestamp precision](#timestamp-precision) below for why).
3. Add one line to `lib/summarisers/index.js` mapping the new class UUID to the plugin.

The dispatcher, queue, state tracking and InfluxDB writer are all file-type-agnostic and need no changes.

## Configuration

Standard Factory+ service client variables are read from the environment by `@amrc-factoryplus/service-client` (`DIRECTORY_URL`, `REALM`, `CLIENT_KEYTAB`, `VERBOSE`, etc.) - see the [service client documentation](vendor/service-client). In addition:

| Variable             | Meaning                                                                    | Default        |
|----------------------|-----------------------------------------------------------------------------|----------------|
| `INFLUX_URL`         | URL of the InfluxDB server.                                                  | *(required)*   |
| `INFLUX_ORG`         | InfluxDB organisation to write to.                                           | *(required)*   |
| `INFLUX_BUCKET`      | InfluxDB bucket to write to.                                                 | *(required)*   |
| `INFLUX_TOKEN`       | InfluxDB auth token.                                                         | *(required)*   |
| `BATCH_SIZE`         | Points to buffer before auto-flushing to InfluxDB.                          | `5000`         |
| `FLUSH_INTERVAL`     | Milliseconds before buffered points are flushed even if `BATCH_SIZE` isn't reached. | `10000` |
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
purely-additive dump file. Everything else (the Deployment, the
`KerberosKey`/identity, the namespace) is entirely this add-on's own
concern.

## Retries

`watch_members` only re-emits when a class's membership actually changes, so a file whose summarisation failed (corrupt data, a transient download error, InfluxDB unavailable, etc.) wouldn't otherwise be retried until some other file was added to the same class. To avoid that, the dispatcher also re-checks all members on a jittered timer (every ~5 minutes) regardless of whether membership changed, and re-queues anything not marked `done`. There's no separate backoff counter - a permanently-broken file is simply retried on this same interval indefinitely, with its last error visible in `Files.App.SummaryState`.

## Timestamp precision

Nanosecond epoch timestamps (~1.7×10^18) exceed what a JSON number / JS `Number` can represent exactly (`Number.MAX_SAFE_INTEGER` is ~9×10^15). To avoid silently corrupting timestamps:

- The TDMS Python script computes timestamps as arbitrary-precision Python integers and emits them as **strings** in its NDJSON output.
- `lib/influx.js` passes that string straight to `Point.timestamp()`, which the InfluxDB client writes verbatim into the line-protocol timestamp field rather than round-tripping it through a floating-point number.

Any new plugin should follow the same convention.

## Known limitations

- **nptdms only exposes microsecond precision for a channel's absolute start time** (`wf_start_time`), even though the TDMS format and `wf_increment` support finer resolution. Per-sample spacing is still nanosecond-accurate (computed from `wf_increment` directly), only the absolute start reference is limited to microseconds - this is a limitation of the `nptdms` library, not of this service.
- **The bounded-memory read only holds if the source TDMS file is written in multiple reasonably-sized segments**, which is how real acquisition hardware streams data to disk. A pathological TDMS file written as a single giant segment can cause `nptdms` to do more work decoding a chunk internally; this was tested and doesn't reintroduce the original full-file-in-memory problem for realistic files, but it's worth knowing about if a summarisation job for a specific file is unexpectedly slow or memory-hungry.
- There's no schema validation on `Files.App.Summary` config values (e.g. a non-numeric `n`).

## Moving to its own repository

This directory currently still lives inside the `amrc-connectivity-stack`
monorepo, but nothing about it depends on that - moving it out is a plain
copy, not a rewrite:

1. Copy this directory to the root of a new repository (e.g.
   `git subtree split` if you want to preserve history, or a plain copy if
   you don't).
2. Push a `vX.Y.Z` tag and publish a GitHub release. `.github/workflows/release.yml`
   picks it up with no changes - see [Building](#building).

Nothing needs to change in `package.json`, the `Dockerfile`, the
`Makefile`, or `deploy/`: they were written to be self-contained precisely
so this move needs no rewiring (see
[Vendored dependencies](#vendored-dependencies) for why `vendor/` exists
instead of ordinary npm dependencies).

**The one thing that does NOT move**: `acs-service-setup/dumps/addon-file-summariser.yaml`
and the `acs-service-setup/lib/uuids.js` entries it references stay in the
`amrc-connectivity-stack` repo permanently, regardless of where this
directory ends up, because only core's `service-setup` job has the
admin-level Auth/ConfigDB access needed to apply them - see
[Bootstrap coupling](#bootstrap-coupling). This is the one integration
point that always requires a core-repo change alongside any change to
this add-on's ConfigDB/Auth objects (new file types, new permissions,
etc.) - everything else here is fully independent.
