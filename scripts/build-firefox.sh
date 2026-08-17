#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="${project_dir}/dist/firefox"
version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${project_dir}/manifest.firefox.json" | head -n 1)"
zip_file="${project_dir}/dist/domnodeshot-firefox-${version}.zip"

mkdir -p "${output_dir}/icons"
cp "${project_dir}/manifest.firefox.json" "${output_dir}/manifest.json"
cp "${project_dir}/background.js" "${output_dir}/background.js"
cp "${project_dir}/content.js" "${output_dir}/content.js"
cp "${project_dir}/styles.css" "${output_dir}/styles.css"
cp "${project_dir}/LICENSE" "${output_dir}/LICENSE"
cp "${project_dir}"/icons/*.png "${output_dir}/icons/"

(
  cd "${output_dir}"
  zip -qrFS "${zip_file}" .
)

echo "Firefox build criado em: ${output_dir}"
echo "ZIP criado em: ${zip_file}"
