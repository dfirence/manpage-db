# Manpage-DB Build System
# Compiles a single standalone CLI executable using Bun cross-compilation

NAME     := manpage-db
CLI_SRC  := src/cli.ts
OUT_DIR  := dist

# Cross-compilation targets
PLATFORMS := darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64

# Bun compile flags
BUN_FLAGS := --compile --minify

.PHONY: help build-all build-darwin-arm64 build-darwin-x64 build-linux-x64 build-linux-arm64 build-windows-x64 build-native clean

## help: Show this help menu (default)
help:
	@echo ""
	@echo "  Manpage-DB Build System (Bun)"
	@echo "  =============================="
	@echo ""
	@echo "  Usage: make <target>"
	@echo ""
	@echo "  Targets:"
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /    /' | column -t -s ':'
	@echo ""

## build-all: Build for all platforms
build-all: $(addprefix build-,$(PLATFORMS))

## build-native: Build for current platform (no suffix)
build-native: | $(OUT_DIR)
	bun build $(BUN_FLAGS) --outfile $(OUT_DIR)/$(NAME) $(CLI_SRC)

## build-darwin-arm64: Build for macOS Apple Silicon
build-darwin-arm64: | $(OUT_DIR)
	bun build $(BUN_FLAGS) --target=bun-darwin-arm64 --outfile $(OUT_DIR)/$(NAME)-darwin-arm64 $(CLI_SRC)

## build-darwin-x64: Build for macOS Intel
build-darwin-x64: | $(OUT_DIR)
	bun build $(BUN_FLAGS) --target=bun-darwin-x64 --outfile $(OUT_DIR)/$(NAME)-darwin-x64 $(CLI_SRC)

## build-linux-x64: Build for Linux x86_64
build-linux-x64: | $(OUT_DIR)
	bun build $(BUN_FLAGS) --target=bun-linux-x64 --outfile $(OUT_DIR)/$(NAME)-linux-x64 $(CLI_SRC)

## build-linux-arm64: Build for Linux ARM64
build-linux-arm64: | $(OUT_DIR)
	bun build $(BUN_FLAGS) --target=bun-linux-arm64 --outfile $(OUT_DIR)/$(NAME)-linux-arm64 $(CLI_SRC)

## build-windows-x64: Build for Windows x86_64
build-windows-x64: | $(OUT_DIR)
	bun build $(BUN_FLAGS) --target=bun-windows-x64 --outfile $(OUT_DIR)/$(NAME)-windows-x64.exe $(CLI_SRC)

## clean: Remove all build artifacts
clean:
	rm -rf $(OUT_DIR)

$(OUT_DIR):
	mkdir -p $(OUT_DIR)
