#!/bin/sh

script_directory=${0%/*}
script_directory=$(cd -P "$script_directory" && pwd)

if [ "$1" = "--version" ]; then
  printf '%s\n' '1.2.3'
elif [ "$1" = "--modversion" ] && [ "$2" = "fake-sdk" ]; then
  printf '%s\n' '4.5.6'
elif [ "$1" = "--cflags" ] && [ "$2" = "fake-sdk" ]; then
  printf '%s\n' "-I'$script_directory/include one' '-DFAKE_VALUE=a b' -I$script_directory/include-two"
else
  printf '%s\n' "unexpected arguments: $*" >&2
  exit 2
fi
