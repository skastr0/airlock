import type { GuestLimits } from "./GuestRunner.ts"

/**
 * The trusted code that runs next to the guest, inside its isolate, as source
 * text. It is the same on every cloud: an adapter evaluates it before the
 * guest's module loads and hands it the bridge to the host.
 *
 * It evaluates to a function `(bridge, loadGuest) => Promise<string>` whose
 * result is always a JSON envelope: `{"ok":true,"result":…}` or
 * `{"ok":false,"error":"<reason>"}`.
 *
 * What it defends against, since the guest shares its realm:
 * - every primitive it needs is captured before the guest runs, so a guest
 *   that replaces `JSON.stringify`, `Object.keys` or a prototype method does
 *   not change what crosses the boundary;
 * - values are serialized by walking own data properties only: no getter and
 *   no `toJSON` is invoked, and anything that is not plain JSON is refused;
 * - size, depth and node count are bounded while serializing, not after;
 * - `console` is replaced, so it is not a second, unbounded output channel;
 * - a limit the guest trips stays tripped even if the guest catches the error;
 * - the guest's own error text never leaves: any failure is a fixed reason.
 *
 * It does not stop a guest burning CPU; that is the platform's limit to
 * enforce. A Proxy's traps can still run, inside the guest, under that limit.
 */
export const guestRuntimeSource = (
  tools: ReadonlyArray<string>,
  limits: GuestLimits,
  /** False only where the guest shares a realm with the host's own console (the in-process reference). */
  silenceConsole = true
): string => `
(() => {
  const limits = ${JSON.stringify(limits)};
  const toolNames = ${JSON.stringify(tools)};
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const own = Object.getOwnPropertyDescriptor;
  const keys = Object.keys;
  const prototypeOf = Object.getPrototypeOf;
  const objectPrototype = Object.prototype;
  const isArray = Array.isArray;
  const finite = Number.isFinite;
  const freeze = Object.freeze;
  const create = Object.create;
  const define = Object.defineProperty;
  const apply = Reflect.apply;
  const encoder = new TextEncoder();
  const encode = encoder.encode.bind(encoder);
  const byteLength = own(prototypeOf(Uint8Array.prototype), "byteLength").get;
  const split = String.prototype.split;
  const tooLarge = {};
  const invalid = {};
  const quota = {};
  const failure = (reason) => '{"ok":false,"error":' + stringify(reason) + "}";

  const quiet = () => {};
  const names = ["log","warn","error","info","debug","trace","dir","dirxml","table","assert","count",
    "countReset","time","timeEnd","timeLog","group","groupCollapsed","groupEnd","clear"];
  const silent = {};
  for (let index = 0; index < names.length; index++) silent[names[index]] = quiet;
  if (${JSON.stringify(silenceConsole)}) {
    define(globalThis, "console", { configurable: false, writable: false, value: freeze(silent) });
  }

  const json = (value, maxBytes) => {
    let text = "";
    let bytes = 0;
    let nodes = 0;
    const append = (token) => {
      if (token.length > maxBytes) throw tooLarge;
      bytes += apply(byteLength, encode(token), []);
      if (bytes > maxBytes) throw tooLarge;
      text += token;
    };
    const visit = (item, depth) => {
      if (++nodes > limits.maxNodes || depth > limits.maxDepth) throw tooLarge;
      if (item === null) return append("null");
      if (item === true) return append("true");
      if (item === false) return append("false");
      if (typeof item === "string") {
        if (item.length > maxBytes) throw tooLarge;
        return append(stringify(item));
      }
      if (typeof item === "number") {
        if (!finite(item)) throw invalid;
        return append(stringify(item));
      }
      if (typeof item !== "object") throw invalid;
      const array = isArray(item);
      const proto = prototypeOf(item);
      if (!array && proto !== objectPrototype && proto !== null) throw invalid;
      if (array) {
        const lengthOf = own(item, "length");
        const length = lengthOf && lengthOf.value;
        if (typeof length !== "number" || length > limits.maxNodes) throw tooLarge;
        append("[");
        for (let index = 0; index < length; index++) {
          if (index > 0) append(",");
          const descriptor = own(item, index);
          if (!descriptor || !own(descriptor, "value")) throw invalid;
          visit(descriptor.value, depth + 1);
        }
        return append("]");
      }
      const names = keys(item);
      if (names.length > limits.maxNodes) throw tooLarge;
      append("{");
      let written = 0;
      for (let index = 0; index < names.length; index++) {
        const descriptor = own(item, names[index]);
        if (!descriptor || !own(descriptor, "value")) throw invalid;
        if (descriptor.value === undefined) continue;
        if (written++ > 0) append(",");
        append(stringify(names[index]));
        append(":");
        visit(descriptor.value, depth + 1);
      }
      return append("}");
    };
    visit(value, 0);
    return text;
  };

  return async (bridge, loadGuest) => {
    let calls = 0;
    let violation;
    const call = (name) => async (input) => {
      if (calls >= limits.maxToolCalls) { violation = "tool_call_limit"; throw quota; }
      calls++;
      let encoded;
      try { encoded = json(input, limits.maxToolInputBytes); }
      catch (error) {
        violation = error === tooLarge ? "tool_input_limit" : "tool_input_invalid";
        throw error;
      }
      // One bounded JSON string out, one JSON string back. No structured value,
      // and so no capability, crosses in either direction.
      const reply = await bridge[name](encoded);
      if (typeof reply !== "string") { violation = "execution_failed"; throw invalid; }
      return parse(reply);
    };
    const root = create(null);
    for (let index = 0; index < toolNames.length; index++) {
      const path = apply(split, toolNames[index], ["."]);
      let node = root;
      for (let depth = 0; depth < path.length - 1; depth++) {
        if (!own(node, path[depth])) define(node, path[depth], { enumerable: true, value: create(null) });
        node = own(node, path[depth]).value;
      }
      define(node, path[path.length - 1], { enumerable: true, value: call(toolNames[index]) });
    }
    const seal = (node) => {
      const names = keys(node);
      for (let index = 0; index < names.length; index++) {
        const child = own(node, names[index]).value;
        if (typeof child === "object") seal(child);
      }
      return freeze(node);
    };
    const tools = seal(root);
    try {
      const guest = await loadGuest();
      const result = await guest(tools);
      if (violation) return failure(violation);
      const prefix = '{"ok":true,"result":';
      return prefix + json(result === undefined ? null : result, limits.maxOutputBytes - prefix.length - 1) + "}";
    } catch (error) {
      return failure(violation || (error === tooLarge ? "output_limit" : error === invalid ? "invalid_output" : "execution_failed"));
    }
  };
})()
`.trim()
