// `buffer`: Herdr declares a small Buffer; Deno's built-in node:buffer is a superset and needs no permission.
import { Buffer } from "node:buffer";
export { Buffer };
export default { Buffer };
