# addon-file-summariser
#
# Self-contained build for this add-on - does not depend on any other
# part of the amrc-connectivity-stack repo. Safe to copy this directory
# out to its own repository as-is.
#
# Create a file `config.mk` here to override the variables below, e.g.
#
#   registry=ghcr.io/my-github-username
#   tag=dev
#
# Useful variables:
#
# registry	Container registry to push images to.
# Defaults to GHCR under this org, which you probably can't push to.
#
# tag		Tag for the image. Defaults to `dev`.
#
# base_version	The version of the ACS base images to build against.
#
# platform	Restrict the platforms to build for (passed to buildx).
#
# k8s.namespace	Namespace to target for the `deploy`/`restart`/`logs` targets.
# k8s.kubeconfig
#		Kubeconfig to use for the same.

-include config.mk

registry?=	ghcr.io/amrc-factoryplus
image?=		addon-file-summariser
tag?=		dev
base_version?=	v4.1.0
platform?=	linux/amd64
revision?=	$(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)

build_args=	\
	--build-arg base_version="$(base_version)" \
	--build-arg revision="$(revision)"

.PHONY: all build push lint setup deploy restart logs

all: build

setup:
	npm install --no-save --install-links

lint:
	npx eslint bin lib

build:
	docker buildx build --load --platform "$(platform)" \
		-t "$(registry)/$(image):$(tag)" $(build_args) .

push:
	docker buildx build --push --platform "$(platform)" \
		-t "$(registry)/$(image):$(tag)" $(build_args) .

kubectl?=	kubectl
ifdef k8s.namespace
kubectl_args+=	-n $(k8s.namespace)
endif
ifdef k8s.kubeconfig
kubectl_args+=	--kubeconfig=$(k8s.kubeconfig)
endif

restart:
	$(kubectl) $(kubectl_args) rollout restart deploy/file-summariser
	$(kubectl) $(kubectl_args) rollout status deploy/file-summariser

logs:
	$(kubectl) $(kubectl_args) logs -f --since=5m deploy/file-summariser

deploy: push restart logs
