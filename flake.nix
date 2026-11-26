{
  description = "Kinome media server";

  # CI uploads Kinome's builds here, including the FFmpeg variant nixpkgs' cache lacks.
  nixConfig = {
    extra-substituters = [ "https://kinome.cachix.org" ];
    extra-trusted-public-keys = [ "kinome.cachix.org-1:Q3VwYYvn8pZxPFmEDcHeeFwJH/HDV7e0UY9WPTe+EZg=" ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, bun2nix }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ bun2nix.overlays.default ];
        };
      in {
        packages.default = pkgs.callPackage ./nix/package.nix { };

        apps.default = flake-utils.lib.mkApp {
          drv = self.packages.${system}.default;
          name = "kinome";
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.go
            pkgs.bun2nix
          ];
        };
      }) // {
        nixosModules.default = import ./nix/module.nix { inherit self; };
      };
}
