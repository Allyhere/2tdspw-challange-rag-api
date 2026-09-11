import { pathToFileURL } from "node:url";

/** Hosts a human may copy into docs-template.md. No crawl; this script only prints URLs. */
export const ALLOWED_HOSTS = [
  "wsava.org",
  "aaha.org",
  "catvets.com",
  "vet.cornell.edu",
  "merckvetmanual.com",
  "saude.sp.gov.br",
  "pasteur.saude.sp.gov.br",
  "akc.org",
  "cfa.org",
];

export const CANDIDATE_URLS = [
  "https://wsava.org/global-guidelines/vaccination-guidelines/",
  "https://www.aaha.org/resources/2022-aaha-aafp-feline-vaccination-guidelines/",
  "https://catvets.com/guidelines/practice-guidelines",
  "https://www.vet.cornell.edu/departments-centers-and-institutes/cornell-feline-health-center",
  "https://www.merckvetmanual.com/",
  "https://www.saude.sp.gov.br/instituto-pasteur",
  "https://www.akc.org/dog-breeds/golden-retriever/",
  "https://www.akc.org/dog-breeds/poodle/",
  "https://cfa.org/persian/",
  "https://cfa.org/siamese/",
];

export function isAllowlisted(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_HOSTS.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );
}

export function harvestCandidates(urls = CANDIDATE_URLS) {
  return urls.filter(isAllowlisted);
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  for (const url of harvestCandidates()) {
    console.log(url);
  }
}
