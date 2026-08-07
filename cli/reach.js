// Why couldn't we reach the daemon?
//
// "no daemon on port 7900. Is the app running?" is the right message for
// exactly one cause — nothing listening. A sandboxed shell, a firewall, or a
// blocked loopback produce a different failure that the same sentence
// misdiagnoses, and it sends you restarting an app that was never down. That
// happened, and it cost twenty minutes.

/**
 * Turns a failed fetch into a sentence that names the actual cause.
 *
 * `cause.code` is where Node puts the syscall error; a timeout arrives as a
 * DOMException with no code at all, which is itself a useful signal — nothing
 * refused the connection, it just never answered.
 */
export function explainUnreachable(error, port) {
  const code = error?.cause?.code ?? error?.code ?? null;

  switch (code) {
    case "ECONNREFUSED":
      return `no daemon on port ${port}. Is the app running?`;

    case "EPERM":
    case "EACCES":
      // The usual cause is an agent or CI shell that sandboxes outbound
      // connections. The daemon may well be running and healthy.
      return (
        `connecting to 127.0.0.1:${port} was denied (${code}) — a sandbox or firewall is ` +
        `blocking loopback, not the daemon. Check from an unsandboxed shell before restarting anything.`
      );

    case "ENETUNREACH":
    case "EHOSTUNREACH":
      return `127.0.0.1:${port} is unreachable (${code}) — loopback networking looks broken on this machine.`;

    default:
      break;
  }

  // A timeout is not a refusal: something accepted the packets and never
  // replied, which a firewall does and a closed port does not.
  if (error?.name === "TimeoutError" || error?.cause?.name === "TimeoutError") {
    return `127.0.0.1:${port} accepted the connection but never answered — something is filtering it.`;
  }

  return `could not reach the daemon on port ${port}${code ? ` (${code})` : ""}. Is the app running?`;
}
