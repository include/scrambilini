# Scrambilini — packaging helpers.
#
# The extension has no compile step: this folder is what Chrome loads. "build"
# means "produce the distributable zip and sanity-check the sources", and
# "release" adds a checksum.
#
# The test harnesses and the icon tool are TypeScript and run on Bun.

NAME       := scrambilini
MANIFEST   := manifest.json
VERSION    := $(shell bun -e "console.log(require('./$(MANIFEST)').version)" 2>/dev/null)
DIST       := dist
ZIP        := $(DIST)/$(NAME)-$(VERSION).zip
CHECKSUM   := $(ZIP).sha256
SOURCES    := manifest.json src icons

UNAME_S    := $(shell uname -s)
SHASUM     := $(if $(filter Darwin,$(UNAME_S)),shasum -a 256,sha256sum)

.DELETE_ON_ERROR:
.DEFAULT_GOAL := help
.PHONY: all help install check build icons release test clean

all: build

help:
	@echo "Scrambilini $(VERSION)"
	@echo ""
	@echo "  make build     sanity-check the sources and build $(ZIP)"
	@echo "  make release   build, then write a SHA-256 next to the zip"
	@echo "  make check     JS syntax, manifest and profile-builder checks"
	@echo "  make install   bun install (test harnesses and icon tool)"
	@echo "  make icons     rebuild icons/ from scrambilini.png"
	@echo "  make test      run the Playwright harnesses (needs a display)"
	@echo "  make clean     remove the dist folder"
	@echo ""
	@echo "The unpacked extension is this folder: $(CURDIR)"

install:
	@bun install

check:
	@test -n "$(VERSION)" || { echo "error: could not read the version from $(MANIFEST)"; exit 1; }
	@bun run tools/check.ts
	@bunx tsc --noEmit

icons:
	@bun run tools/icons.ts

build: check
	@mkdir -p $(DIST)
	@rm -f $(ZIP)
	@zip -qr $(ZIP) $(SOURCES) -x '*.DS_Store' '*/.DS_Store'
	@unzip -t $(ZIP) > /dev/null || { echo "error: $(ZIP) is corrupt"; exit 1; }
	@unzip -l $(ZIP) | grep -q ' manifest.json$$' \
		|| { echo "error: $(ZIP) has no manifest.json at the root"; exit 1; }
	@echo "build: $(ZIP) ($$(du -h $(ZIP) | cut -f1))"
	@echo "       load unpacked from $(CURDIR)"

release: build
	@cd $(DIST) && $(SHASUM) $(notdir $(ZIP)) > $(notdir $(CHECKSUM))
	@echo "release: $(VERSION)"
	@cat $(CHECKSUM)
	@echo ""
	@echo "Share $(ZIP). It has to be unzipped before Chrome will load it."

test:
	@bun run test/all.ts

clean:
	@rm -rf $(DIST)
	@echo "clean: removed $(DIST)"
