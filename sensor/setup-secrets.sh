#!/bin/zsh
# Вписує Wi-Fi і токен GitHub у secrets.h (файл не потрапляє в git). Пароль не видно при вводі.
# Токен береться з уже заповненого secrets.h, а якщо там його немає - з буфера обміну.
cd "${0:A:h}"
tok=$(sed -n 's/#define GH_TOKEN "\(github_pat_.*\)"/\1/p' secrets.h 2>/dev/null)
[[ -n $tok ]] || tok=$(pbpaste | tr -d '[:space:]')
[[ $tok == github_pat_* ]] || { echo "Немає токена github_pat_...: скопіюйте його в буфер і запустіть ще раз"; exit 1; }
read "ssid?Назва Wi-Fi (2.4 ГГц): "
read -s "pass?Пароль Wi-Fi: "; echo
esc() { print -r -- "${1//\\/\\\\}" | sed 's/"/\\"/g'; }
cat > secrets.h <<EOF
#define WIFI_SSID "$(esc "$ssid")"
#define WIFI_PASS "$(esc "$pass")"
#define GH_TOKEN "$tok"
EOF
chmod 600 secrets.h
echo "Готово: secrets.h записаний"
