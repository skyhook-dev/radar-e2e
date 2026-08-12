# Shared contract for dist-e2e job fragments

Each agent writes ONE file under jobs/ (or a directory for the CLI e2e). They are
assembled into a single workflow later, so nobody edits a shared file.

Every fragment may assume a job that already exists:

    resolve-version:
      outputs:
        version: the latest published radar release WITHOUT the leading v, e.g. 1.9.2
        tag:     the same with the v, e.g. v1.9.2

Reference it as: needs: resolve-version, then
    ${{ needs.resolve-version.outputs.version }}

Rules for every fragment:
- Assert the INSTALLED version equals that version. This guard is the whole
  point: the CLI Homebrew formula is currently stuck at 1.3.2 while the latest
  release is 1.9.2, and nothing noticed.
- Fail with a message that says what a human should do about it.
- Public repo: Linux, macOS and Windows runners are all free.
- No secrets are needed - everything under test is published publicly.
