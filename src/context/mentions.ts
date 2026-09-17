import { AttachmentRef } from '../types';

/** Palabras reservadas: tienen prioridad sobre un archivo con el mismo nombre. */
const RESERVED: Record<string, AttachmentRef> = {
  activo: { kind: 'activeFile' },
  seleccion: { kind: 'selection' },
  arbol: { kind: 'tree' },
};

/**
 * Una mención empieza con `@` al inicio del texto o tras un espacio y llega hasta el siguiente espacio,
 * así `usuario@dominio.com` no cuenta. Las rutas con espacios no se pueden mencionar.
 */
const MENTION = /(?:^|\s)@(\S+)/g;

export function parseMentions(text: string): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  for (const match of text.matchAll(MENTION)) {
    const token = match[1];
    refs.push(RESERVED[token] ?? { kind: 'file', path: token });
  }
  return dedupeRefs(refs);
}

/** Máximo de sugerencias del autocompletado, para que sea rápido en workspaces grandes. */
export const MAX_SUGGESTIONS = 20;

/**
 * Sugerencias para `@query`: palabras reservadas y rutas que contienen la consulta, sin distinguir mayúsculas.
 * Primero las reservadas, después las rutas cuyo nombre de archivo empieza por la consulta y luego el resto.
 */
export function suggestMentions(query: string, files: string[]): string[] {
  const q = query.toLowerCase();
  const reserved = Object.keys(RESERVED).filter((word) => word.includes(q));
  const matches = files.filter((file) => file.toLowerCase().includes(q));
  const basename = (file: string) => file.slice(file.lastIndexOf('/') + 1).toLowerCase();
  const byName = matches.filter((file) => basename(file).startsWith(q));
  const rest = matches.filter((file) => !basename(file).startsWith(q));
  return [...reserved, ...byName, ...rest].slice(0, MAX_SUGGESTIONS);
}

/** Quita duplicados (mismo `kind` y misma `path`) conservando la primera aparición. */
export function dedupeRefs(refs: AttachmentRef[]): AttachmentRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = refKey(ref);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function refKey(ref: AttachmentRef): string {
  if (ref.kind !== 'file') {
    return ref.kind;
  }
  // `./src/a.ts`, `src\a.ts` y `src/a.ts` son el mismo archivo.
  const normalized = ref.path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/');
  return `file:${normalized}`;
}
