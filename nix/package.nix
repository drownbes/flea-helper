# Production node_modules plus src/, run by Node directly (type stripping, no build step).
{
  lib,
  stdenv,
  fetchPnpmDeps,
  pnpmConfigHook,
  pnpm_12,
  nodejs_26,
  makeWrapper,
}:
let
  packageJson = lib.importJSON ../package.json;
  pnpm = pnpm_12;
in
stdenv.mkDerivation (finalAttrs: {
  pname = "flea-helper";
  inherit (packageJson) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../pnpm-lock.yaml
      ../src
    ];
  };

  nativeBuildInputs = [
    nodejs_26
    pnpm
    pnpmConfigHook
    makeWrapper
  ];

  pnpmInstallFlags = [ "--prod" ];
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs)
      pname
      version
      src
      pnpmInstallFlags
      ;
    inherit pnpm;
    fetcherVersion = 4;
    hash = "sha256-hmfejrypndevD8B54JYKTnv0xI0/9FQHX+XmUBG8JjU=";
  };

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    app=$out/lib/flea-helper
    mkdir -p $app $out/bin
    cp -r package.json src node_modules $app/
    makeWrapper ${lib.getExe nodejs_26} $out/bin/flea --add-flags $app/src/flea.ts

    runHook postInstall
  '';

  meta = {
    description = "Identify used items from photos, research prices, and draft a Slack flea-market post";
    mainProgram = "flea";
  };
})
