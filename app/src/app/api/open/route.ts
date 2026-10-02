import { commandRoute } from "@/lib/commands";

// Opens the chat in the remote Teams: the agent then keeps its messages up to date
export const POST = commandRoute("open");
