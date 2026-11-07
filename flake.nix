{
  description = "Role Orchestrator: JavaScript development and packaging foundation";

  # Exact upstream revision; update deliberately together with flake.lock.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/f9a75f41be3a74eab55d3a7679d34ad6cc0da977";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: import nixpkgs { inherit system; };
    in {
      devShells = forAllSystems (system:
        let pkgs = pkgsFor system;
        in {
          default = pkgs.mkShell {
            packages = [ pkgs.nodejs_24 ];
          };
        });

      # Product-independent metadata check; it also works without development/.
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
              assert.equal(lock.lockfileVersion, 3);
              assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
            ' ${./package.json} ${./package-lock.json}
            touch "$out"
          '';
        });

      # packages/apps are added with the real CLI in C10.10, never a fake binary.
    };
}
