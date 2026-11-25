# Both stages use the official x86_64 Arch userspace and a full pacman upgrade.
ARG SCRATCHTREE_SMOKE_BASE=installed-preview
FROM docker.io/library/archlinux:base AS package
RUN pacman -Syu --noconfirm --needed base-devel && useradd --create-home builder
WORKDIR /home/builder
COPY --chown=builder:builder PKGBUILD scratchtree-preview.deb ./
USER builder
ARG SCRATCHTREE_VERSION
ARG SCRATCHTREE_DEB_SHA256
RUN makepkg --noconfirm --nodeps && mkdir package && \
    mv scratchtree-preview-*.pkg.tar.zst package/
# Repackage the same Debian bundle at the next numeric Arch package revision.
RUN release_version=$(pacman -Qp -- package/*.pkg.tar.zst) && \
    base_revision=${release_version##*-} && \
    case "$base_revision" in ''|0*|*[!0-9]*) exit 1 ;; esac && \
    upgrade_revision=$((base_revision + 1)) && \
    printf '\npkgrel=%s\n' "$upgrade_revision" >> PKGBUILD && \
    makepkg --noconfirm --nodeps --cleanbuild && mkdir upgrade && \
    mv "scratchtree-preview-${SCRATCHTREE_VERSION}-$upgrade_revision-x86_64.pkg.tar.zst" upgrade/

FROM docker.io/library/archlinux:base AS installed-preview
COPY --from=package /home/builder/package/ /package/
COPY --from=package /home/builder/upgrade/ /upgrade/
RUN pacman -Syu --noconfirm && pacman -U --noconfirm /package/*.pkg.tar.zst && \
    pacman -Qkk scratchtree-preview && ldd /usr/bin/scratchtree-preview > /tmp/scratchtree-ldd && \
    cat /tmp/scratchtree-ldd && ! grep -F 'not found' /tmp/scratchtree-ldd

FROM docker.io/library/archlinux:base AS released-package-dependencies
COPY release-dependencies.txt /tmp/scratchtree-release-dependencies
RUN bash -euc 'mapfile -t dependencies < /tmp/scratchtree-release-dependencies; \
    pacman -Syu --noconfirm --needed "${dependencies[@]}"'

FROM ${SCRATCHTREE_SMOKE_BASE}
RUN pacman -S --noconfirm --needed desktop-file-utils diffutils gnupg imagemagick openbox xclip xdotool xorg-server-xvfb xorg-xauth && \
    useradd --create-home smoke
COPY arch-preview.sh /usr/local/bin/arch-preview
COPY arch-signing.sh /usr/local/bin/arch-signing
COPY stage-signed-repo.sh /usr/local/bin/stage-signed-repo
USER smoke
WORKDIR /home/smoke
CMD ["dbus-run-session", "--", "xvfb-run", "-a", "-s", "-screen 0 1440x960x24", "bash", "/usr/local/bin/arch-preview"]
