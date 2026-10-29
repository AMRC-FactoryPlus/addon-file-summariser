# Installing alongside an existing ACS cluster

This is the step-by-step runbook for adding `addon-file-summariser` to a
cluster that already has a working central AMRC Connectivity Stack
deployment. For the values reference, upgrade/uninstall commands, and
background on why each step is needed, see [README.md](README.md).

## Step 0 - get the core-side changes into that cluster (one-time)

This add-on's core-side prerequisite - the isolated ConfigDB/Auth bootstrap
dump - is a change to the core `amrc-connectivity-stack` repo that a cluster
running an older release won't have yet:

- `acs-service-setup/dumps/addon-file-summariser.yaml` (the new ConfigDB/Auth
  objects) is **baked into the `acs-service-setup` image**, not mounted
  from a ConfigMap, so it only takes effect once that image is rebuilt.

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

```sh
kubectl create namespace addon-file-summariser
```

## Step 3 - create the polling API's credentials

The HTTP API a dedicated acs-edge REST connection polls isn't
Factory+-mediated, so this is a manual step - same posture as the InfluxDB
token used to be:

```sh
kubectl -n addon-file-summariser create secret generic file-summariser-api-auth \
  --from-literal=username=edge-agent \
  --from-literal=password="$(openssl rand -base64 24)"
```

Keep the password - you'll need it again when configuring the REST
connection in the Manager.

## Step 4 - create the Factory+ service account and its credentials Secret

There's no krb-keys-operator involvement - create the account yourself
(Kerberos principal/password via `kadmin`, plus a ConfigDB identity of class
`Auth.Class.CentralService` in group
`Files.Requirement.SummariserServiceAccount`; see README.md's
[Service account](README.md#service-account) section for the exact UUIDs
and what the account needs), then put its credentials in a Secret:

```sh
kubectl -n addon-file-summariser create secret generic file-summariser-service-auth \
  --from-literal=username=<the account's principal> \
  --from-literal=password=<the account's password>
```

## Step 5 - install the chart

```sh
helm install addon-file-summariser ./addon-file-summariser/deploy \
  -n addon-file-summariser \
  --set image.registry=<your-registry> \
  --set image.tag=dev \
  --set factoryPlus.directoryUrl=http://directory.<core-namespace>.svc.cluster.local
```

## Step 6 - verify

```sh
kubectl -n addon-file-summariser get pods
kubectl -n addon-file-summariser logs deploy/file-summariser
```

A healthy pod logs `Starting File Summariser, revision ...` then sits
idle. To confirm it actually works end-to-end, upload a TDMS file through
ACS-Files, watch `Files.App.SummaryState` in ConfigDB for it to turn
`done`, then check the polling API directly:

```sh
kubectl -n addon-file-summariser port-forward svc/file-summariser-api 8080:8080 &
curl -u edge-agent:<password from Step 3> \
  http://localhost:8080/v1/devices/<device_uuid>/channels
```

Getting the data all the way into InfluxDB also needs the acs-edge side set
up (a dedicated REST connection polling this API, with one device/metric
per machine and channel) - see
`docs/plans/2026-10-21-tdms-summary-edge-agent-ingestion.{md,html}` in the
`amrc-connectivity-stack` repo.

If auth to Factory+ fails, check the pod's logs first: the most common
cause is the `file-summariser-service-auth` Secret's `username`/`password`
not actually matching a valid, enabled Factory+ account (double check the
account exists and the Kerberos password wasn't mistyped). The next most
common cause is Step 0's bootstrap dump not having landed, so the account's
group/class membership doesn't grant the permissions this service needs.
