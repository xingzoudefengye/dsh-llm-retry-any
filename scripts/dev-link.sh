#!/usr/bin/env bash
# Link the installed DeepSeek Harness packages this bundle imports into this
# checkout, so a *local-path* install can resolve them.
#
# Why this is needed: `dsh plugin add /abs/path` installs a `link:` dependency,
# and Node's ESM resolver follows that symlink to this repository's real path.
# Resolution then walks up from here and never reaches the profile's
# node_modules. A git install has no such problem, so this is a development
# convenience, not part of a normal install.
#
# Usage: scripts/dev-link.sh [directory containing @deepseek-ai/dsh-*]
#   DSH_PACKAGE_DIR  same, via environment
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# zod 从内置的 dsh-llm-retry 自带副本取，版本与上游一致。
packages=(schemastery)

resolve() {
	local target="$1" dir
	while [ -L "$target" ]; do
		dir="$(cd "$(dirname "$target")" && pwd)"
		target="$(readlink "$target")"
		case "$target" in
		/*) ;;
		*) target="$dir/$target" ;;
		esac
	done
	printf '%s\n' "$target"
}

package_dir="${1:-${DSH_PACKAGE_DIR:-}}"
if [ -z "$package_dir" ]; then
	dsh_bin="$(command -v dsh || true)"
	[ -n "$dsh_bin" ] || { echo "dev-link: 找不到 dsh，请显式传 @deepseek-ai/dsh-* 所在目录" >&2; exit 1; }
	dsh_pkg="$(cd "$(dirname "$(resolve "$dsh_bin")")/.." && pwd)"
	package_dir="$dsh_pkg/node_modules/@deepseek-ai"
fi

[ -d "$package_dir/schemastery" ] || { echo "dev-link: $package_dir 下没有 schemastery" >&2; exit 1; }

mkdir -p "$here/node_modules/@deepseek-ai"
for pkg in "${packages[@]}"; do
	ln -sfn "$(cd "$package_dir" && pwd)/$pkg" "$here/node_modules/@deepseek-ai/$pkg"
	echo "dev-link: linked @deepseek-ai/$pkg"
done

# zod：上游 dsh-llm-retry 自带 4.4.3，这里直接链它的副本。
zod_src="$package_dir/dsh-llm-retry/node_modules/zod"
if [ -d "$zod_src" ]; then
	ln -sfn "$(cd "$zod_src" && pwd)" "$here/node_modules/zod"
	echo "dev-link: linked zod (from dsh-llm-retry)"
else
	echo "dev-link: 未找到内置 zod 副本，跳过（git 安装不需要它）" >&2
fi

echo "dev-link: 本地 link: 安装现在可以解析 harness 包了"
