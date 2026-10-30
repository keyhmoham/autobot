# The Nomad agent ./openduet.sh runs when COMPUTER_BACKEND=nomad: one node, server and client.
#
# The docker driver is the only thing that matters here. Computers keep their profile and workspace in
# named docker volumes (supervisor/src/backends/nomad.ts), which the driver mounts only with volumes
# enabled, and their confinement is set on each job, so nothing is allowed here beyond that.
data_dir = "/var/lib/nomad"

client {
  enabled = true
}

plugin "docker" {
  config {
    volumes {
      enabled = true
    }
    allow_runtimes = ["runc", "runsc"]
  }
}
