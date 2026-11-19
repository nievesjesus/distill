import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './paths.mjs';

export const TAGS = ['simple', 'deep', 'table', 'chart', 'office', 'multi'];
const EXPECTED_TYPES = ['number', 'text', 'oneOf'];

export function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadCorpus(path = join(repoRoot, 'bench', 'corpus.json')) {
  return loadJson(path);
}

export function loadTasks(path = join(repoRoot, 'bench', 'tasks.json')) {
  return loadJson(path);
}

export function validate(corpus, tasks) {
  const errors = [];
  if (!Array.isArray(corpus)) return ['corpus must be an array'];
  if (!Array.isArray(tasks)) return ['tasks must be an array'];
  const docIds = new Set();
  for (const doc of corpus) {
    if (typeof doc?.id !== 'string' || doc.id === '') {
      errors.push('corpus entry without id');
      continue;
    }
    if (docIds.has(doc.id)) errors.push(`duplicate doc id ${doc.id}`);
    docIds.add(doc.id);
    if (typeof doc.ext !== 'string' || !/^[a-z0-9]+$/.test(doc.ext)) errors.push(`doc ${doc.id}: bad ext`);
    if (typeof doc.local === 'string') {
      if (!/^demo:[A-Za-z0-9._-]+$/.test(doc.local)) errors.push(`doc ${doc.id}: bad local reference`);
    } else {
      if (typeof doc.url !== 'string' || !/^https:\/\//.test(doc.url)) errors.push(`doc ${doc.id}: url must be https`);
      if (typeof doc.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(doc.sha256)) errors.push(`doc ${doc.id}: bad sha256`);
      if (typeof doc.license !== 'string' || doc.license === '') errors.push(`doc ${doc.id}: missing license`);
    }
  }
  const taskIds = new Set();
  for (const task of tasks) {
    const id = task?.id;
    if (typeof id !== 'string' || id === '') {
      errors.push('task without id');
      continue;
    }
    if (taskIds.has(id)) errors.push(`duplicate task id ${id}`);
    taskIds.add(id);
    if (!docIds.has(task.doc)) errors.push(`task ${id}: unknown doc ${task.doc}`);
    if (typeof task.question !== 'string' || task.question.trim() === '') errors.push(`task ${id}: missing question`);
    if (typeof task.source !== 'string' || task.source.trim() === '') errors.push(`task ${id}: missing source`);
    if (!Array.isArray(task.tags) || task.tags.length === 0) errors.push(`task ${id}: missing tags`);
    else for (const tag of task.tags) if (!TAGS.includes(tag)) errors.push(`task ${id}: unknown tag ${tag}`);
    const expected = task.expected;
    if (typeof expected !== 'object' || expected === null || !EXPECTED_TYPES.includes(expected.type)) {
      errors.push(`task ${id}: bad expected type`);
      continue;
    }
    if (expected.type === 'number') {
      if (typeof expected.value !== 'number' || !Number.isFinite(expected.value)) errors.push(`task ${id}: number value required`);
      if (expected.tolerance !== undefined && (typeof expected.tolerance !== 'number' || expected.tolerance < 0)) errors.push(`task ${id}: bad tolerance`);
    } else if (expected.type === 'text') {
      if (typeof expected.value !== 'string' || expected.value === '') errors.push(`task ${id}: text value required`);
    } else if (!Array.isArray(expected.value) || expected.value.length === 0 || expected.value.some((v) => typeof v !== 'string' || v === '')) {
      errors.push(`task ${id}: oneOf needs a non-empty string array`);
    }
  }
  return errors;
}

export function selectTasks(tasks, filter) {
  if (typeof filter !== 'string' || filter.trim() === '') return tasks;
  const clauses = filter.split(',').map((c) => c.trim()).filter(Boolean);
  return tasks.filter((task) =>
    clauses.some((clause) => {
      if (clause.startsWith('tag:')) return task.tags.includes(clause.slice(4));
      if (clause.startsWith('doc:')) return task.doc === clause.slice(4);
      const id = clause.startsWith('id:') ? clause.slice(3) : clause;
      return task.id === id;
    }),
  );
}

export function docFileName(doc) {
  return `${doc.id}.${doc.ext}`;
}
