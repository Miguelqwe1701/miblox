import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A short-lived, signed statement from the portal that says who a player is.
 *
 * The portal is the only process holding the Migood client secret. Rather than
 * giving every place server those credentials, the portal verifies the player
 * once and hands them a ticket; the place server checks the signature with a
 * secret the two share and never talks to Migood at all.
 */
export interface Ticket {
  /** MiBlox account id, or "" for a guest. */
  accountId: string;
  username: string;
  placeId: string;
  /**
   * The player's HumanoidDescription.
   *
   * Carried in the ticket rather than looked up, so a game server needs no
   * database connection at all. It is inside the signature, so a client cannot
   * edit its own appearance on the way in.
   */
  avatar?: Record<string, unknown>;
  /** Unix seconds. Tickets are deliberately short-lived. */
  exp: number;
}

export const TICKET_TTL_SECONDS = 120;

export function signTicket(ticket: Ticket, secret: string): string {
  const body = Buffer.from(JSON.stringify(ticket), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export class TicketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketError";
  }
}

export function verifyTicket(token: string, secret: string, placeId: string): Ticket {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) throw new TicketError("Malformed ticket");
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new TicketError("Ticket signature did not match");
  }

  let ticket: Ticket;
  try {
    ticket = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Ticket;
  } catch {
    throw new TicketError("Malformed ticket payload");
  }
  if (ticket.exp * 1000 < Date.now()) throw new TicketError("Ticket expired");
  // A ticket for one place must not be redeemable at another.
  if (ticket.placeId !== placeId) throw new TicketError("Ticket is for a different place");
  return ticket;
}

export function newTicket(
  opts: {
    accountId: string;
    username: string;
    placeId: string;
    avatar?: Record<string, unknown>;
  },
  secret: string,
): string {
  return signTicket(
    { ...opts, exp: Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS },
    secret,
  );
}
