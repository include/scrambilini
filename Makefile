# Scrambilini — two extensions, one core.
#
# The shared source lives in shared/. "make sync" copies it into chrome/ and
# firefox/ (the copies are committed, so each folder loads without a build).
#
# The test harnesses and the icon tool are TypeScript and run on Bun.

NAME       := scrambilini
VERSION    := $(shell bun -e "console.log(require('./chrome/manifest.json').version)" 2>/dev/null)
DIST       := dist
CHROME_ZIP := $(DIST)/$(NAME)-chrome-$(VERSION).zip
FIREFOX_ZIP:= $(DIST)/$(NAME)-firefox-$(VERSION).zip

UNAME_S    := $(shell uname -s)
SHASUM     := $(if $(filter Darwin,$(UNAME_S)),shasum -a 256,sha256sum)

.DELETE_ON_ERROR:
.DEFAULT_GOAL := help
.PHONY: all help install sync check icons build build-chrome build-firefox \
        release release-chrome release-firefox test test-chrome test-firefox clean

all: build

help:
	@echo "Scrambilini $(VERSION) — Chrome + Firefox"
	@echo ""
	@echo "  make sync            copy shared/ into chrome/ and firefox/"
	@echo "  make build           sync, check, then build both zips"
	@echo "  make release         build both zips and write their SHA-256"
	@echo "  make build-chrome    build $(CHROME_ZIP)"
	@echo "  make build-firefox   build $(FIREFOX_ZIP)"
	@echo "  make check           JS syntax, manifests and profile-builder checks"
	@echo "  make install         bun install (test harnesses and icon tool)"
	@echo "  make icons           rebuild shared/icons/ from images/scrambilini.png"
	@echo "  make test            run the Chrome suite and the Firefox smoke test"
	@echo "  make clean           remove the dist folder"
	@echo ""
	@echo "  chrome/   load unpacked from $(CURDIR)/chrome"
	@echo "  firefox/  load temporary add-on from $(CURDIR)/firefox/manifest.json"

install:
	@bun install

sync:
	@bun run tools/sync.ts

check: sync
	@bun run tools/check.ts
	@bunx tsc --noEmit

icons:
	@bun run tools/icons.ts
	@bun run tools/sync.ts

build: build-chrome build-firefox

build-chrome: check
	@mkdir -p $(DIST)
	@rm -f $(CHROME_ZIP)
	@cd chrome && zip -qr "../$(CHROME_ZIP)" manifest.json src icons -x '*.DS_Store' '*/.DS_Store'
	@unzip -t $(CHROME_ZIP) > /dev/null || { echo "error: $(CHROME_ZIP) is corrupt"; exit 1; }
	@unzip -l $(CHROME_ZIP) | grep -q ' manifest.json$$' \
		|| { echo "error: $(CHROME_ZIP) has no manifest.json at the root"; exit 1; }
	@echo "build: $(CHROME_ZIP) ($$(du -h $(CHROME_ZIP) | cut -f1))"

build-firefox: check
	@mkdir -p $(DIST)
	@rm -f $(FIREFOX_ZIP)
	@cd firefox && zip -qr "../$(FIREFOX_ZIP)" manifest.json src icons -x '*.DS_Store' '*/.DS_Store'
	@unzip -t $(FIREFOX_ZIP) > /dev/null || { echo "error: $(FIREFOX_ZIP) is corrupt"; exit 1; }
	@unzip -l $(FIREFOX_ZIP) | grep -q ' manifest.json$$' \
		|| { echo "error: $(FIREFOX_ZIP) has no manifest.json at the root"; exit 1; }
	@echo "build: $(FIREFOX_ZIP) ($$(du -h $(FIREFOX_ZIP) | cut -f1))"

release: release-chrome release-firefox

release-chrome: build-chrome
	@cd $(DIST) && $(SHASUM) $(notdir $(CHROME_ZIP)) > $(notdir $(CHROME_ZIP)).sha256
	@cat $(CHROME_ZIP).sha256

release-firefox: build-firefox
	@cd $(DIST) && $(SHASUM) $(notdir $(FIREFOX_ZIP)) > $(notdir $(FIREFOX_ZIP)).sha256
	@cat $(FIREFOX_ZIP).sha256

test: test-chrome test-firefox

test-chrome:
	@bun run test/all.ts

test-firefox:
	@bun run test/firefox.ts

clean:
	@rm -rf $(DIST)
	@echo "clean: removed $(DIST)"
