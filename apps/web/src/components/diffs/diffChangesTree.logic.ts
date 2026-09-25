/**
 * The changed-files tree the diff panel lists. Folders that hold nothing but one other folder are
 * merged into a single row (`apps / web / src`), folders sort before files, and each level sorts
 * by name.
 */
export type DiffChangesTreeRow<F> =
  | {
      readonly kind: "directory";
      /** Full path of the deepest merged folder; the key collapse state is stored under. */
      readonly path: string;
      readonly segments: ReadonlyArray<string>;
      readonly depth: number;
      readonly expanded: boolean;
      /** Every file below the folder, for the totals a collapsed folder shows. */
      readonly files: ReadonlyArray<F>;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly name: string;
      readonly depth: number;
      readonly file: F;
    };

interface DirectoryNode<F> {
  readonly directories: Map<string, DirectoryNode<F>>;
  readonly files: Array<{ readonly name: string; readonly path: string; readonly file: F }>;
}

const compareNames = (left: string, right: string) =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });

function descendantFiles<F>(node: DirectoryNode<F>): F[] {
  return [
    ...node.files.map((entry) => entry.file),
    ...[...node.directories.values()].flatMap(descendantFiles),
  ];
}

function emptyNode<F>(): DirectoryNode<F> {
  return { directories: new Map(), files: [] };
}

function buildTree<F>(files: ReadonlyArray<F>, pathOf: (file: F) => string): DirectoryNode<F> {
  const root = emptyNode<F>();
  for (const file of files) {
    const path = pathOf(file);
    const segments = path.split("/").filter((segment) => segment.length > 0);
    const name = segments.pop();
    if (name === undefined) continue;
    let node = root;
    for (const segment of segments) {
      let child = node.directories.get(segment);
      if (!child) {
        child = emptyNode<F>();
        node.directories.set(segment, child);
      }
      node = child;
    }
    node.files.push({ name, path, file });
  }
  return root;
}

/**
 * Visible rows, depth-first. A collapsed folder still shows its own row; searching passes an
 * empty set so every match stays in view.
 */
export function buildDiffChangesTreeRows<F>(
  files: ReadonlyArray<F>,
  pathOf: (file: F) => string,
  collapsedPaths: ReadonlySet<string>,
): ReadonlyArray<DiffChangesTreeRow<F>> {
  const rows: DiffChangesTreeRow<F>[] = [];

  const visit = (node: DirectoryNode<F>, parentPath: string, depth: number) => {
    const directoryNames = [...node.directories.keys()].toSorted(compareNames);
    for (const directoryName of directoryNames) {
      let child = node.directories.get(directoryName)!;
      const segments = [directoryName];
      while (child.files.length === 0 && child.directories.size === 1) {
        const [onlyName, onlyChild] = [...child.directories][0]!;
        segments.push(onlyName);
        child = onlyChild;
      }
      const path = parentPath ? `${parentPath}/${segments.join("/")}` : segments.join("/");
      const expanded = !collapsedPaths.has(path);
      rows.push({
        kind: "directory",
        path,
        segments,
        depth,
        expanded,
        files: descendantFiles(child),
      });
      if (expanded) visit(child, path, depth + 1);
    }
    for (const entry of node.files.toSorted((left, right) => compareNames(left.name, right.name))) {
      rows.push({ kind: "file", path: entry.path, name: entry.name, depth, file: entry.file });
    }
  };

  visit(buildTree(files, pathOf), "", 0);
  return rows;
}

/** Files in the order the tree lists them, for "first file" and next/previous. */
export function orderDiffChangesTreeFiles<F>(
  files: ReadonlyArray<F>,
  pathOf: (file: F) => string,
): ReadonlyArray<F> {
  return buildDiffChangesTreeRows(files, pathOf, new Set()).flatMap((row) =>
    row.kind === "file" ? [row.file] : [],
  );
}
