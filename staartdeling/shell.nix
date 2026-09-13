{
  pkgs ? import <nixpkgs> {},
  agent-illustrator ? builtins.getFlake "github:kervel/agent-illustrator"
}:

let
  fonts = with pkgs; [
    liberation_ttf
    noto-fonts
    roboto
  ];

  fontConfig = pkgs.makeFontsConf { fontDirectories = fonts; };

  # Get agent-illustrator for current system
  system = pkgs.stdenv.hostPlatform.system;
  ail = agent-illustrator.packages.${system}.default;
in
pkgs.mkShell {
  buildInputs = with pkgs; [
    nodejs
    mermaid-cli
    chromium
    fontconfig
    ail
    inotify-tools
    playwright-driver.browsers
  ] ++ fonts;

  FONTCONFIG_FILE = fontConfig;
  PUPPETEER_EXECUTABLE_PATH = "${pkgs.chromium}/bin/chromium";

  # Required for running Chrome as root in CI containers
  PUPPETEER_ARGS = "--no-sandbox --disable-setuid-sandbox";

  # Playwright uses Nix-provided browsers
  PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
}
