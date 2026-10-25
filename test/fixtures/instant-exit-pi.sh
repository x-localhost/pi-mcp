#!/bin/sh
# Minimal fake Pi used to exercise worker.mjs's handling of a Pi process that
# exits (with no children of its own) before the worker can read its /proc
# identity. A native shell exits far faster than a Node ESM module could, so
# this maximises the chance that worker.mjs's processIdentity(child.pid) call
# observes the process already gone.
case "$1" in
  --version) echo "1.4.0" ;;
esac
