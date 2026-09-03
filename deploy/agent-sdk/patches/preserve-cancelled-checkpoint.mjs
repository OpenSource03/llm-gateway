import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const REPLACEMENTS = [
  {
    label: "stream interruption guard",
    before:
      "const interruptedMappingMayBeAdvanced = !managedForkTarget || managedForkPublished || clientAssistantContentExposed;",
    after:
      "const interruptedMappingMayBeAdvanced = !managedForkTarget || managedForkPublished;",
  },
  {
    label: "closed-stream guard",
    before:
      "const mayEvictInterruptedMapping = !managedForkTarget || managedForkPublished || clientAssistantContentExposed;",
    after:
      "const mayEvictInterruptedMapping = !managedForkTarget || managedForkPublished;",
  },
  {
    label: "downstream cancellation guard",
    before:
      "if (!isIndependentSession && (!managedForkTarget || managedForkPublished || clientAssistantContentExposed)) {",
    after:
      "if (!isIndependentSession && (!managedForkTarget || managedForkPublished)) {",
  },
];

const occurrences = (source, value) => source.split(value).length - 1;

export const preserveCancelledCheckpoint = (source) => {
  let patched = source;

  for (const replacement of REPLACEMENTS) {
    const count = occurrences(patched, replacement.before);

    if (count !== 1) {
      throw new Error(
        `Meridian ${replacement.label} signature count is ${count}; expected exactly one`,
      );
    }
    patched = patched.replace(replacement.before, replacement.after);
  }

  return patched;
};

const findServerBundle = async (distDirectory) => {
  const candidates = [];

  for (const entry of await readdir(distDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const file = path.join(distDirectory, entry.name);
    const source = await readFile(file, "utf8");

    if (source.includes(REPLACEMENTS[0].before))
      candidates.push({ file, source });
  }
  if (candidates.length !== 1) {
    throw new Error(
      `Found ${candidates.length} Meridian server bundles; expected exactly one`,
    );
  }

  return candidates[0];
};

export const patchMeridianDistribution = async (distDirectory) => {
  const candidate = await findServerBundle(distDirectory);
  const patched = preserveCancelledCheckpoint(candidate.source);

  await writeFile(candidate.file, patched, "utf8");
};

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const distDirectory = process.argv[2];

  if (!distDirectory) {
    throw new Error("Usage: preserve-cancelled-checkpoint.mjs <meridian-dist>");
  }
  await patchMeridianDistribution(path.resolve(distDirectory));
}
