import ignore from 'ignore';
import * as vscode from 'vscode';

/** Máximo de rutas del árbol. Sin límite, un workspace grande llenaría el presupuesto de tokens. */
export const MAX_TREE_PATHS = 2000;

/**
 * Rutas de archivo de la carpeta, relativas y con `/`, ordenadas alfabéticamente por segmentos.
 * Solo aplica `files.exclude`; es la lista que ofrecen el QuickPick y el autocompletado.
 */
export async function findWorkspaceFiles(folder: vscode.WorkspaceFolder): Promise<string[]> {
  // `exclude` undefined aplica las exclusiones por defecto, incluido `files.exclude`.
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'));
  return uris.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort(comparePaths);
}

/** Como `findWorkspaceFiles`, pero filtrando además con el `.gitignore` raíz, que `findFiles` no respeta. */
export async function listWorkspaceFiles(folder: vscode.WorkspaceFolder): Promise<string[]> {
  const ig = ignore().add(await readRootGitignore(folder));
  return (await findWorkspaceFiles(folder)).filter((rel) => !ig.ignores(rel));
}

/** Árbol indentado de la primera carpeta del workspace, cortado en `MAX_TREE_PATHS` rutas. */
export async function buildTree(folder: vscode.WorkspaceFolder): Promise<string> {
  const files = await listWorkspaceFiles(folder);
  const shown = files.slice(0, MAX_TREE_PATHS);

  const lines = [`${folder.name}/`];
  let previous: string[] = [];
  for (const file of shown) {
    const segments = file.split('/');
    // Solo se escriben las carpetas que no compartía la ruta anterior.
    let common = 0;
    while (common < segments.length - 1 && common < previous.length - 1 && segments[common] === previous[common]) {
      common++;
    }
    for (let depth = common; depth < segments.length - 1; depth++) {
      lines.push(`${indent(depth + 1)}${segments[depth]}/`);
    }
    lines.push(`${indent(segments.length)}${segments[segments.length - 1]}`);
    previous = segments;
  }

  const omitted = files.length - shown.length;
  if (omitted > 0) {
    lines.push(`… (${omitted} rutas omitidas)`);
  }
  return lines.join('\n');
}

async function readRootGitignore(folder: vscode.WorkspaceFolder): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.gitignore'));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

/** Compara por segmentos para que el contenido de cada carpeta quede contiguo y en orden. */
function comparePaths(a: string, b: string): number {
  const sa = a.split('/');
  const sb = b.split('/');
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    if (sa[i] !== sb[i]) {
      return sa[i] < sb[i] ? -1 : 1;
    }
  }
  return sa.length - sb.length;
}

function indent(depth: number): string {
  return '  '.repeat(depth);
}
