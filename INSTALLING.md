# Installing alongside an existing ACS cluster

This is the step-by-step runbook for adding `addon-file-summariser` to a
cluster that already has a working central AMRC Connectivity Stack
deployment. For the values reference, upgrade/uninstall commands, and
background on why each step is needed, see [README.md](README.md).

## Step 0 - get the core-side changes into that cluster (one-time)

This add-on's core-side prerequisites - the isolated ConfigDB/Auth
bootstrap dump and the krb-keys-operator's `addon-*` namespace watch - are
changes to the core `amrc-connectivity-stack` repo that a cluster running
an older release won't have yet:

- `acs-service-setup/dumps/addon-file-summariser.yaml` (the new ConfigDB/Auth
  objects) is **baked into the `acs-service-setup` image**, not mounted
  from a ConfigMap, so it only takes effect once that image is rebuilt.
- The krb-keys-operator's `WATCH_NAMESPACES` only includes `addon-*` once
  the core chart is upgraded to a version with that change.

Before touching the add-on itself, upgrade the existing core release:

```sh
cd amrc-connectivity-stack   # a checkout that includes these changes

# rebuild acs-service-setup so the new dump is baked in
cd acs-service-setup && make push registry=<your-registry> tag=dev && cd ..

# upgrade the existing core release in place
helm upgrade <core-release-name> ./deploy \
  -n <core-namespace> \
  --reuse-values \
  --set serviceSetup.image.registry=<your-registry> \
  --set serviceSetup.image.tag=dev
```

Confirm it landed:

```sh
# a fresh service-setup-<random> Job should have run
kubectl -n <core-namespace> get jobs -l job-name

# look for the addon-file-summariser.yaml dump loading without errors
kubectl -n <core-namespace> logs job/<the new service-setup job>

# confirm the wildcard rolled out
kubectl -n <core-namespace> get deploy krb-keys-operator \
  -o jsonpath='{.spec.template.spec.containers[0].env}' | grep -o 'addon-\*'
```

If you're going through a real GitHub release rather than a dev build,
wait for the next tagged core release instead of overriding
`serviceSetup.image.tag` by hand.

## Step 1 - build the add-on image

```sh
cd addon-file-summariser
make push registry=<your-registry> tag=dev base_version=v4.1.0
```

## Step 2 - create the namespace

Must match `addon-*` so the krb-keys-operator (from Step 0) picks it up
automatically:

```sh
kubectl create namespace addon-file-summariser
```

## Step 3 - copy the InfluxDB token across

InfluxDB access isn't Factory+-mediated, so this is a manual step:

```sh
kubectl -n <core-namespace> get secret influxdb-auth -o json \
  | jq 'del(.metadata) | .metadata.name="influxdb-auth"' \
  | kubectl -n addon-file-summariser apply -f -
```

## Step 4 - install the chart

You need four values from your existing core deployment - get them with:

```sh
helm get values <core-release-name> -n <core-namespace> | grep -E 'realm|baseUrl'
```

Then:

```sh
helm install addon-file-summariser ./addon-file-summariser/deploy \
  -n addon-file-summariser \
  --set image.registry=<your-registry> \
  --set image.tag=dev \
  --set factoryPlus.directoryUrl=http://directory.<core-namespace>.svc.cluster.local \
  --set factoryPlus.realm=<identity.realm from above> \
  --set factoryPlus.baseUrl=<acs.baseUrl from above> \
  --set factoryPlus.coreNamespace=<core-namespace> \
  --set influx.url=http://acs-influxdb2.<core-namespace>.svc.cluster.local
```

## Step 5 - verify

```sh
kubectl -n addon-file-summariser get pods
kubectl -n addon-file-summariser get krb sv1filesummariser   # SECRET column should be populated
kubectl -n addon-file-summariser logs deploy/file-summariser
```

A healthy pod logs `Starting File Summariser, revision ...` then sits
idle. To confirm it actually works end-to-end, upload a TDMS file through
ACS-Files and watch `Files.App.SummaryState` in ConfigDB (or the InfluxDB
bucket) for the resulting summary.

If the `KerberosKey` never gets a Secret, that's almost always Step 0's
krb-keys-operator upgrade not having landed - check that first.
