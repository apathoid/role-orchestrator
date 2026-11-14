{
  description = "Role Orchestrator: Model-first orchestration with Node.js 24";

  # Exact upstream revision; update deliberately together with flake.lock.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/f9a75f41be3a74eab55d3a7679d34ad6cc0da977";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: import nixpkgs { inherit system; };
      productSource = nixpkgs.lib.fileset.toSource {
        root = ./.;
        fileset = nixpkgs.lib.fileset.unions [
          ./src ./package.json ./package-lock.json ./.npmrc ./README.md ./CHANGELOG.md
          ./docs/PRODUCT.md ./docs/ARCHITECTURE.md ./docs/CONTRACTS.md ./docs/EXECUTION.md ./docs/CONTEXT_AND_RECOVERY.md ./docs/PROVIDERS_AND_CONFIGURATION.md ./docs/REASONING_EFFORT.md ./docs/DIAGNOSTICS.md ./docs/DECISIONS.md ./docs/NIX_AND_CI.md ./docs/EXTENSIONS.md ./docs/CAPABILITIES.md
        ];
      };
      packageFor = pkgs: pkgs.buildNpmPackage {
        pname = "role-orchestrator";
        version = "0.1.0-dev.0";
        src = productSource;
        nodejs = pkgs.nodejs_24;
        npmDepsHash = "sha256-zVo+cwI0Sj/6Es/PhL7VOyTo/IeIWqPUTg+7yOX3a54=";
        npmFlags = [ "--ignore-scripts" ];
        dontNpmBuild = true;
        meta.mainProgram = "role-orchestrator";
      };
    in {
      devShells = forAllSystems (system:
        let pkgs = pkgsFor system;
        in {
          default = pkgs.mkShell {
            packages = [ pkgs.nodejs_24 ];
          };
        });

      packages = forAllSystems (system:
        let package = packageFor (pkgsFor system);
        in {
          role-orchestrator = package;
          default = package;
        });

      apps = forAllSystems (system:
        let
          package = packageFor (pkgsFor system);
          app = { type = "app"; program = "${package}/bin/role-orchestrator"; };
        in {
          role-orchestrator = app;
          default = app;
        });

      # Both checks also work without development/.
      checks = forAllSystems (system:
        let pkgs = pkgsFor system;
        in {
          package-metadata = pkgs.runCommand "role-orchestrator-package-metadata" {
            nativeBuildInputs = [ pkgs.nodejs_24 ];
          } ''
            node --input-type=module -e '
              import assert from "node:assert/strict";
              import { readFileSync } from "node:fs";
              const pkg = JSON.parse(readFileSync(process.argv[1], "utf8"));
              const lock = JSON.parse(readFileSync(process.argv[2], "utf8"));
              assert.equal(pkg.name, "role-orchestrator");
              assert.equal(pkg.type, "module");
              assert.equal(pkg.engines.node, "^24.0.0");
              assert.equal(pkg.bin["role-orchestrator"], "./src/main/cli.js");
              assert.equal(lock.lockfileVersion, 3);
              assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
            ' ${./package.json} ${./package-lock.json}
            touch "$out"
          '';
          cli-smoke = pkgs.runCommand "role-orchestrator-cli-smoke" {} ''
            ${packageFor pkgs}/bin/role-orchestrator --help | grep 'Usage: role-orchestrator'
            ${packageFor pkgs}/bin/role-orchestrator acp --help | grep 'Usage: role-orchestrator acp'
            touch "$out"
          '';
        });
    };
}
