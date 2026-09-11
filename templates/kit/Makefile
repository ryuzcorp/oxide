# REQUIRED entrypoint for the kit celld demo.
# Do not use `docker/podman compose up` alone — see compose.yaml header.
#
#   make up      # start stack (detached); exits when ready
#   make logs    # follow celld + rustfs
#   make down

COMPOSE ?= $(shell command -v docker >/dev/null 2>&1 && echo 'docker compose' || echo 'podman compose')

-include .env
export

.PHONY: up down logs

up:
	$(COMPOSE) up --build -d rustfs
	$(COMPOSE) run --rm --no-deps rustfs-init
	$(COMPOSE) run --rm --build kit
	$(COMPOSE) up -d celld
	@echo "open http://localhost:$${KIT_PORT:-8080}"
	@echo "follow logs: make logs"

logs:
	$(COMPOSE) logs -f celld rustfs

down:
	-$(COMPOSE) down -v --remove-orphans
