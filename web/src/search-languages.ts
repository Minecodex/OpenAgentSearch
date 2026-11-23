// Google Search language and region settings, plus CLDR official regional languages.
// See docs/plan1/04-routing-and-providers.md for sources and selection criteria.
// prettier-ignore
export const routingLanguages: readonly string[] = [
  "ab", "ach", "ady", "af", "ak", "am", "ar", "as", "ast", "av", "ay", "az",
  "az-Arab", "az-Cyrl", "ba", "ban", "be", "bem", "bg", "bi", "bjt", "bn", "br", "bs",
  "bs-Cyrl", "bsc", "bua", "ca", "caa", "cak", "ce", "ceb", "chp", "chr", "ckb", "co",
  "crk", "crs", "cs", "csb", "cy", "da", "de", "den", "dgr", "dv", "dyo", "dz",
  "ee", "el", "en", "eo", "es", "es-419", "et", "eu", "fa", "ff", "fi", "fil",
  "fj", "fo", "fr", "frr", "fy", "ga", "gaa", "gd", "gil", "gl", "gn", "gsw",
  "gu", "gv", "gwi", "ha", "hak", "hak-Hant", "haw", "he", "hi", "hif", "hil", "ho",
  "hr", "ht", "hu", "hy", "ia", "id", "ig", "ilo", "inh", "is", "it", "iu",
  "iu-Latn", "ixl", "ja", "jv", "ka", "kbd", "kg", "kha", "kk", "kl", "km", "kn",
  "knf", "ko", "koi", "kok", "krc", "kri", "ks", "kum", "kv", "ky", "la", "lb",
  "lbe", "lez", "lg", "ln", "lo", "loz", "lt", "lua", "lv", "mai", "mdf", "mdh",
  "mey", "mey-Latn", "mfe", "mfv", "mg", "mi", "mk", "ml", "mn", "mr", "ms", "ms-Arab",
  "mt", "my", "myv", "na", "nan", "nan-Hant", "nb", "nd", "ne", "niu", "nl", "nn",
  "no", "nr", "nso", "ny", "nyn", "oc", "om", "or", "os", "pa", "pag", "pcm",
  "pl", "ps", "pt", "pt-BR", "pt-PT", "qu", "quc", "quv", "rm", "rn", "ro", "ru",
  "rw", "sa", "sah", "sat", "sav", "sd", "sd-Deva", "se", "sg", "si", "sk", "sl",
  "sm", "sms", "sn", "snf", "so", "sq", "sr", "sr-Latn", "sr-ME", "srr", "ss", "st",
  "su", "sv", "sw", "ta", "te", "tet", "tg", "th", "ti", "tk", "tn", "tnr",
  "to", "tpi", "tr", "ts", "tsg", "tt", "tum", "tw", "tyv", "tzm", "udm", "ug",
  "uk", "ur", "usp", "uz", "uz-Arab", "uz-Cyrl", "ve", "vec", "vi", "war", "wo", "xh",
  "xin", "yi", "yo", "zh", "zh-CN", "zh-Hant", "zh-TW", "zu",
];

// Registered language names for locales where the browser lacks a translation.
const registeredNames: Record<string, string> = {
  bjt: "Balanta-Ganja",
  bsc: "Bassari",
  caa: "Chortí",
  cak: "Kaqchikel",
  hif: "Fiji Hindi",
  ixl: "Ixil",
  knf: "Mankanya",
  kri: "Krio",
  lbe: "Lak",
  mdh: "Maguindanaon",
  mey: "Hassaniyya",
  mfv: "Mandjak",
  quv: "Sacapulteco",
  sav: "Saafi-Saafi",
  snf: "Noon",
  tnr: "Ménik",
  tsg: "Tausug",
  usp: "Uspanteco",
  xin: "Xinca",
};

export function searchLanguageOptions(
  locale: string,
  extra: readonly string[] = [],
) {
  return languageOptions([...routingLanguages, ...extra], locale);
}

export function languageOptions(codes: readonly string[], locale: string) {
  const local = new Intl.DisplayNames([locale], {
    type: "language",
    fallback: "none",
  });
  const english = new Intl.DisplayNames(["en"], {
    type: "language",
    fallback: "none",
  });
  const sort = new Intl.Collator(locale);
  return [...new Set(codes.filter(Boolean))]
    .map((code) => {
      const registeredName = registeredNames[code.split("-")[0]] || "";
      let name = registeredName || code,
        englishName = name;
      try {
        englishName = english.of(code) || englishName;
        name = local.of(code) || englishName;
      } catch {
        /* Older saved rules may contain an unrecognized tag. */
      }
      return {
        code,
        label: name + " · " + code,
        search: (
          name +
          " " +
          englishName +
          " " +
          registeredName +
          " " +
          code
        ).toLocaleLowerCase(locale),
      };
    })
    .sort((a, b) => sort.compare(a.label, b.label));
}
