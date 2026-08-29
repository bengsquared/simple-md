/** /Users/<name>/foo -> ~/foo */
export function tildify(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

/** Keep the informative tail of a path, truncating the middle. */
export function middleTruncate(path: string, max: number): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  let tail = "";
  for (let i = parts.length - 1; i > 0; i--) {
    const next = parts[i] + (tail ? "/" + tail : "");
    if (next.length + 2 > max) break;
    tail = next;
  }
  return (parts[0] || "/") + "/…/" + tail;
}

export function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function dirName(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}
