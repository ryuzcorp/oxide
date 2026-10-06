# Entrypoint for the kit celld demo. Plain `docker compose up` also works
# (compose.yaml orders RustFS → bucket → deploy → celld itself).
#
#   make up      # build + start the stack, detached
#   make logs    # follow celld + rustfs
#   make down

COMPOSE ?= $(shell command -v docker >/dev/null 2>&1 && echo 'docker compose' || echo 'podman compose')

-include .env
export

.PHONY: up down logs

up:
	$(COMPOSE) up --build -d
	@echo "open http://localhost:$${KIT_PORT:-8080}"
	@echo "redeploy: $(COMPOSE) run --rm kit   # rebuilds and POSTs /reload"
	@echo "follow logs: make logs"

logs:
	$(COMPOSE) logs -f celld rustfs

down:
	-$(COMPOSE) down -v --remove-orphans
