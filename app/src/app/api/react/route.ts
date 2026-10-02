import { commandRoute } from "@/lib/commands";

// {emoji}: one of the six quick reactions. {pill}: the emoji of a reaction already under the message,
// clicked like in Teams (removed if it is yours, added otherwise).
export const POST = commandRoute("react");
