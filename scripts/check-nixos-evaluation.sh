#!/usr/bin/env bash
set -euo pipefail

# Evaluates an actual NixOS module graph from the pinned nixpkgs revision.
# This does not boot NixOS or verify native providers.
result="$(nix eval --impure --json --expr '
let
  project = builtins.getFlake (toString ./.);
  system = "x86_64-linux";
  package = project.packages.${system}.role-orchestrator;
  nixos = project.inputs.nixpkgs.lib.nixosSystem {
    inherit system;
    modules = [
      ({ ... }: {
        system.stateVersion = "25.11";
        environment.systemPackages = [ package ];
      })
    ];
  };
in builtins.elem (toString package) (map toString nixos.config.environment.systemPackages)
')"

if [[ "$result" != "true" ]]; then
  printf 'FAIL NixOS systemPackages evaluation: %s\n' "$result" >&2
  exit 1
fi
printf 'PASS x86_64-linux NixOS module evaluation includes role-orchestrator package (no boot/native test)\n'
