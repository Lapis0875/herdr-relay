# herdr-relay's Homebrew formula (docs/DECISIONS.md O4, docs/OSS-PLAN.md T47): prepared here, NOT published.
#
# To publish (each push needs the user's explicit go-ahead, O6): once GitHub release v<version> exists, copy this file
# to Formula/herdr-relay.rb in the tap repository Lapis0875/homebrew-herdr-relay, with `url` naming that version and
# `sha256` taken from the release's herdr-relay-<version>.tar.gz.sha256 (tools/release/build.ts). The digest below is
# the local 0.1.0 dry run (.tmp/release/herdr-relay-0.1.0.tar.gz.sha256); the archive's bytes follow HEAD's commit
# time, so it changes with every commit: replace it on release.
class HerdrRelay < Formula
  desc "Relay Herdr's layouts, mods and terminals to phones and tablets via Tailscale"
  homepage "https://github.com/Lapis0875/herdr-relay"
  url "https://github.com/Lapis0875/herdr-relay/releases/download/v0.1.0/herdr-relay-0.1.0.tar.gz"
  sha256 "2a5f3dd0127e4a77274ffdff7ef309e03100053c3e933b9035f95c5ae274be59"
  license "Apache-2.0"

  depends_on "deno"
  depends_on :macos

  def install
    # The release folder is the launcher's repository root: packages/bridge/bin/herdr-relay finds it from its own
    # path, and herdr-relay writes nothing inside it while running (docs/INSTALL.md §2).
    libexec.install Dir["*"]
    # Homebrew's deno first on PATH: the launcher, the bridge and the mod hosts all run `deno` by name.
    (bin/"herdr-relay").write_env_script libexec/"packages/bridge/bin/herdr-relay",
                                        PATH: "#{formula_opt_bin("deno")}:$PATH"
  end

  service do
    run [opt_bin/"herdr-relay", "start"]
    # The launchd label of decision O6, shared with tools/launchd/: one agent, whichever way it was installed.
    name macos: "io.github.lapis0875.herdr-relay"
    # launchd's own PATH lacks ~/.local/bin, where Herdr puts herdr-app and hc (the bridge runs them by name).
    # `brew services` evaluates this as the user starting the service.
    environment_variables PATH: "#{Dir.home}/.local/bin:#{std_service_path_env}"
    keep_alive successful_exit: false
    throttle_interval 30
    log_path var/"log/herdr-relay.log"
    error_log_path var/"log/herdr-relay.log"
  end

  test do
    # doctor exits 1 when any check fails. In the test sandbox HOME is empty and Herdr, Tailscale and the Seatbelt
    # probe may be missing or refused, so FAIL and warn lines are expected; what must work is the launcher (it fetches
    # the locked modules on this first run), the CLI under Homebrew's deno, and a complete report.
    output = shell_output("#{bin}/herdr-relay doctor 2>&1; echo \"doctor exit $?\"")
    assert_match(/^ok +deno: /, output)
    assert_match(/^\d+ failed, \d+ warnings?, \d+ ok$/, output)
    assert_match(/^doctor exit [01]$/, output)
  end
end
