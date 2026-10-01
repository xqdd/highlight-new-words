#!/usr/bin/env bash
# 下载内置词书/词典构建所需的原始数据（固定到具体 commit，保证可复现）。
# 用法：scripts/data/fetch-raw.sh [raw目录=.cache/data-raw]
#   --with-ultimate  额外下载 ECDICT-ultimate（98MB zip，只用其 pos 词性占比给短释义排序，可选）
# 之后执行：node scripts/data/build-data.mjs --raw <raw目录>
set -euo pipefail

RAW="${1:-.cache/data-raw}"
WITH_ULTIMATE=0
for a in "$@"; do [[ "$a" == "--with-ultimate" ]] && WITH_ULTIMATE=1; done
[[ "$RAW" == --* ]] && RAW=.cache/data-raw
mkdir -p "$RAW/cefrj" "$RAW/kyle"

# 数据源与版本（升级时改 commit 并重新构建）
ECDICT_SHA=bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b          # skywind3000/ECDICT（MIT）
CEFRJ_SHA=d4e45b75b38f27b30dfc5c44d8c571aec7e7092f           # openlanguageprofiles/olp-en-cefrj（CEFR-J 1.5，免费商用需署名）
KYLE_SHA=c4c6c80879ff17d7025c28fb853a4991c8e6be6a            # KyleBing/english-vocabulary（BSD-3，只用词表，不用释义）

gh_raw() { # gh_raw <owner/repo> <sha> <path> <输出文件>
  curl -fsSL --retry 3 -o "$4" "https://raw.githubusercontent.com/$1/$2/$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$3")"
}

gh_raw skywind3000/ECDICT "$ECDICT_SHA" ecdict.csv "$RAW/ecdict.csv"
gh_raw skywind3000/ECDICT "$ECDICT_SHA" lemma.en.txt "$RAW/lemma.en.txt"
gh_raw openlanguageprofiles/olp-en-cefrj "$CEFRJ_SHA" cefrj-vocabulary-profile-1.5.csv "$RAW/cefrj/cefrj-vocabulary-profile-1.5.csv"
gh_raw KyleBing/english-vocabulary "$KYLE_SHA" "7 SAT-乱序.txt" "$RAW/kyle/7 SAT-乱序.txt"
gh_raw KyleBing/english-vocabulary "$KYLE_SHA" "full_line_tsv/simple/正序/专四.txt" "$RAW/kyle/tsv_专四.txt"
gh_raw KyleBing/english-vocabulary "$KYLE_SHA" "full_line_tsv/simple/正序/专八.txt" "$RAW/kyle/tsv_专八.txt"

if [[ $WITH_ULTIMATE == 1 ]]; then
  # Release 资产，需 gh CLI
  gh release download -R skywind3000/ECDICT-ultimate -p ecdict-ultimate-csv.zip -D "$RAW" --clobber
  mkdir -p "$RAW/ultimate" && unzip -o -q "$RAW/ecdict-ultimate-csv.zip" -d "$RAW/ultimate"
fi
echo "raw data ready in $RAW"
