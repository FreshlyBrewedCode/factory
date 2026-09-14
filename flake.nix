{
  description = "factory — dev shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # nixpkgs trails Bun upstream by a minor or two, so the shell pins the
      # official release binary rather than pkgs.bun. To bump: change `version`,
      # then refresh each hash with
      #   nix store prefetch-file --hash-type sha256 \
      #     https://github.com/oven-sh/bun/releases/download/bun-v<version>/bun-<target>.zip
      version = "1.4.2";
      targets = {
        x86_64-linux = { target = "linux-x64"; hash = "sha256-NjaPrvdSeHXV/6UuU81IAhdB8qg+tiCKjdZAaNQiqRM="; };
        aarch64-linux = { target = "linux-aarch64"; hash = "sha256-VDKLvC2cjgyfiSxUTWbFeoO4QTnjSQnl7oF1jxrI/ac="; };
        x86_64-darwin = { target = "darwin-x64"; hash = "sha256-gFINfhdSYwjJGF0mFnmsbSd5jTgDoOn3/5Ehq4r/sBI="; };
        aarch64-darwin = { target = "darwin-aarch64"; hash = "sha256-kJh6OhbX21VtiGrD1VHnttPt8KHPQ6yu1iLoZ2vh0S8="; };
      };

      mkBun = pkgs:
        let spec = targets.${pkgs.stdenv.hostPlatform.system};
        in
        pkgs.stdenv.mkDerivation {
          pname = "bun";
          inherit version;

          src = pkgs.fetchurl {
            url = "https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-${spec.target}.zip";
            inherit (spec) hash;
          };

          nativeBuildInputs = [ pkgs.unzip ]
            ++ pkgs.lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.autoPatchelfHook;
          buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.stdenv.cc.cc.lib ];

          # The release zips ship a single prebuilt executable.
          dontBuild = true;
          dontConfigure = true;
          sourceRoot = "bun-${spec.target}";

          installPhase = ''
            runHook preInstall
            install -Dm755 bun "$out/bin/bun"
            ln -s bun "$out/bin/bunx"
            runHook postInstall
          '';

          meta = {
            description = "Incredibly fast JavaScript runtime, bundler, transpiler and package manager";
            homepage = "https://bun.sh";
            mainProgram = "bun";
            platforms = builtins.attrNames targets;
            sourceProvenance = [ pkgs.lib.sourceTypes.binaryNativeCode ];
          };
        };
      # Playwright's own browser downloads (via `playwright-cli install-browser`)
      # are generic Linux binaries built against an FHS distro, so they need
      # their shared libs on LD_LIBRARY_PATH on NixOS — there's no `nixpkgs`
      # browser build to fall back on since @playwright/cli tracks a much
      # newer Chromium revision than nixpkgs' playwright-driver ships. This
      # list is exactly what `validateHostRequirements` reported missing.
      playwrightLibs = pkgs: with pkgs; [
        stdenv.cc.cc.lib
        glib
        nss
        nspr
        dbus
        atk
        at-spi2-atk
        at-spi2-core
        cups
        expat
        libxkbcommon
        gtk3
        pango
        cairo
        gdk-pixbuf
        fontconfig
        freetype
        mesa
        libgbm
        alsa-lib
        libx11
        libxcomposite
        libxdamage
        libxext
        libxfixes
        libxrandr
        libxcb
        libxcursor
        libxi
        libxrender
      ];
    in
    {
      packages = forAllSystems (pkgs: {
        bun = mkBun pkgs;
        default = mkBun pkgs;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [ (mkBun pkgs) ]
            ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux (playwrightLibs pkgs);

          shellHook = ''
            echo "factory devshell — bun $(bun --version)"
          '' + pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
            export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath (playwrightLibs pkgs)}:$LD_LIBRARY_PATH"
          '';
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixpkgs-fmt);
    };
}
