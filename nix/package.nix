{ lib
, stdenv
, bun2nix
, bun
, go
, git
, zip
}:

let
  packageJson = lib.importJSON ../package.json;

  bunTarget = {
    x86_64-linux = "bun-linux-x64";
    aarch64-linux = "bun-linux-arm64";
  }.${stdenv.hostPlatform.system} or (throw "Unsupported Kinome target: ${stdenv.hostPlatform.system}");
in
bun2nix.mkDerivation {
  pname = "kinome";
  version = packageJson.version;

  src = lib.cleanSourceWith {
    src = lib.cleanSource ../.;
    filter = name: type:
      let base = baseNameOf name;
      in !(lib.elem base [
        ".git"
        "dist"
        "node_modules"
        "out"
        "nfpm.temp.yaml"
      ]);
  };

  packageJson = ../package.json;
  bunDeps = bun2nix.fetchBunDeps {
    bunNix = "${
      stdenv.mkDerivation {
        name = "kinome-bun-nix";
        dontUnpack = true;
        nativeBuildInputs = [ bun2nix ];
        installPhase = ''
          mkdir -p $out
          bun2nix -l ${../bun.lock} -o $out/bun.nix
        '';
      }
    }/bun.nix";
  };

  nativeBuildInputs = [ bun go git zip ];

  preBuild = ''
    export HOME=$TMPDIR
    export GOCACHE=$TMPDIR/go-cache
    export GOPATH=$TMPDIR/go
  '';

  buildPhase = ''
    runHook preBuild

    mkdir -p public/bin dist
    bun run build:handler
    bun run build
    bun build --compile --target=${bunTarget} --minify --sourcemap \
      --define "process.env.NODE_ENV='production'" \
      ./src/main/server.ts \
      --outfile dist/kinome

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 dist/kinome $out/bin/kinome
    mkdir -p $out/share/kinome
    cp -r out public $out/share/kinome/

    runHook postInstall
  '';

  meta = {
    description = "A media server and manager";
    homepage = "https://github.com/fiso64/kinome";
    license = lib.licenses.mit;
    mainProgram = "kinome";
    platforms = [ "x86_64-linux" "aarch64-linux" ];
  };
}
