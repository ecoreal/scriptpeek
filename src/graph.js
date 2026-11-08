// src/graph.js — dependency graph construction and full simple-path enumeration
// from the project root, powering `scan` dependency chains and `explain`.
// Zero dependencies: Node.js standard library only.

// Build adjacency: key -> sorted child keys. Root is the pseudo-node ''.
// Edges are resolved with npm's nearest-upward rule: a dep binds to the closest
// node_modules/<name> walking up from the requiring package's directory.
export function buildGraph(lock) {
  const nodes = lock.nodes;
  const edges = new Map();
  edges.set('', childrenOf('', lock.rootDependencies ?? {}, nodes));
  for (const [key, rec] of nodes) {
    edges.set(key, childrenOf(key, rec.dependencies ?? {}, nodes));
  }
  // child -> [parents], for reverse-reachability pruning in allPaths
  const parents = new Map();
  for (const [parent, kids] of edges) {
    for (const k of kids) {
      if (!parents.has(k)) parents.set(k, []);
      parents.get(k).push(parent);
    }
  }
  return { nodes, edges, parents };
}

function childrenOf(key, deps, nodes) {
  const out = [];
  for (const depName of Object.keys(deps)) {
    const child = resolveDep(key, depName, nodes);
    if (child !== null && !out.includes(child)) out.push(child);
  }
  return out.sort();
}

// Nearest node_modules walk-up. Key "node_modules/a/node_modules/b" tries
// "node_modules/a/node_modules/b/node_modules/<dep>", then "node_modules/a/node_modules/<dep>",
// then "node_modules/<dep>". Returns null when no installed entry matches.
function resolveDep(key, depName, nodes) {
  let dir = key;
  for (;;) {
    const cand = dir ? `${dir}/node_modules/${depName}` : `node_modules/${depName}`;
    if (nodes.has(cand)) return cand;
    if (!dir) return null;
    const idx = dir.lastIndexOf('/node_modules/');
    if (idx === -1) {
      if (dir.startsWith('node_modules/')) dir = '';
      else return null; // non-node_modules prefix (e.g. workspaces): nowhere further up
    } else {
      dir = dir.slice(0, idx);
    }
  }
}

// Safety cap for path enumeration. A 7-layer x 8-wide fully connected DAG yields
// 262,144 paths for ONE package (~hundreds of MB of JSON); real graphs can be
// worse. Enumeration stops at the cap (DFS prefix order) instead of OOM-ing.
export const MAX_PATHS_PER_TARGET = 1000;

// All simple paths root -> targetKey, as arrays of keys starting with '' (root).
// The on-stack set cuts dependency cycles: each node appears at most once per
// path, so enumeration always terminates even on cyclic graphs.
// Reverse-reachability pruning skips nodes that cannot reach the target —
// without it a wide DAG makes the DFS burn its budget inside subtrees that
// never touch the target (measured 83ms per mid-layer target on an 8x7
// full-connect graph before pruning; ~0ms after). Pruning changes only which
// branches are visited, never which paths are recorded.
// Returns { paths, truncated }; truncated means enumeration hit `limit` and
// stopped early — the list is a DFS-order prefix, not proof of completeness.
export function allPaths(graph, targetKey, { limit = MAX_PATHS_PER_TARGET } = {}) {
  const canReach = new Set([targetKey]);
  const queue = [targetKey];
  while (queue.length > 0) {
    const cur = queue.pop();
    for (const p of graph.parents.get(cur) ?? []) {
      if (!canReach.has(p)) {
        canReach.add(p);
        queue.push(p);
      }
    }
  }
  const paths = [];
  let truncated = false;
  const stack = [''];
  const onStack = new Set(['']);
  // dfs returns true as a stop signal once the cap is hit, unwinding immediately.
  const dfs = (node) => {
    for (const k of graph.edges.get(node) ?? []) {
      if (!canReach.has(k)) continue; // provably cannot reach the target
      if (k === targetKey) {
        if (paths.length >= limit) {
          truncated = true;
          return true;
        }
        paths.push([...stack, k]); // record and stop: a simple path ends at its target
        continue;
      }
      if (onStack.has(k)) continue; // cycle short-circuit
      onStack.add(k);
      stack.push(k);
      const stop = dfs(k);
      stack.pop();
      onStack.delete(k);
      if (stop) return true;
    }
    return false;
  };
  dfs('');
  return { paths, truncated };
}

// Turn a key path into display names; root becomes the project name (or "root").
export function pathNames(graph, pathKeys, projectName) {
  return pathKeys.map((k) => (k === '' ? projectName ?? 'root' : graph.nodes.get(k)?.name ?? k));
}
