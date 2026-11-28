#!/bin/zsh
# Публікує прошивку для оновлення по повітрю: збирає без секретів (-DOTA_BUILD) і кладе реліз fw-N
# з sensor.bin і version.txt. Перед запуском підняти FW_VER у sensor.ino і закомітити.
set -e
cd "${0:A:h}"
ver=$(sed -n 's/^#define FW_VER \([0-9]*\).*/\1/p' sensor.ino)
out=$(mktemp -d)
arduino-cli compile -b esp32:esp32:esp32 --build-property "compiler.cpp.extra_flags=-DOTA_BUILD" --output-dir "$out" .
strings "$out/sensor.ino.bin" | grep -q github_pat_ && { echo "У збірці токен - стоп"; exit 1; }
echo $ver > "$out/version.txt"
cp "$out/sensor.ino.bin" "$out/sensor.bin"
gh release create "fw-$ver" "$out/sensor.bin" "$out/version.txt" -R NoireLab-dev/svitlo-bot -t "Прошивка датчика $ver" -n "Плата поставить сама протягом години"
echo "Реліз fw-$ver опубліковано"
