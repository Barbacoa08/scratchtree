# Both stages use the official x86_64 Arch userspace and a full pacman upgrade.
FROM docker.io/library/archlinux:base AS package
RUN pacman -Syu --noconfirm --needed base-devel && useradd --create-home builder
WORKDIR /home/builder
COPY --chown=builder:builder PKGBUILD scratchtree-preview.deb ./
USER builder
ARG SCRATCHTREE_VERSION
ARG SCRATCHTREE_DEB_SHA256
RUN makepkg --noconfirm --nodeps && mkdir /home/builder/package && \
    mv scratchtree-preview-*.pkg.tar.zst /home/builder/package/

FROM docker.io/library/archlinux:base
COPY --from=package /home/builder/package/ /package/
RUN pacman -Syu --noconfirm && pacman -U --noconfirm /package/*.pkg.tar.zst && \
    pacman -Qkk scratchtree-preview && ldd /usr/bin/scratchtree-preview > /tmp/scratchtree-ldd && \
    cat /tmp/scratchtree-ldd && ! grep -F 'not found' /tmp/scratchtree-ldd
RUN pacman -S --noconfirm --needed desktop-file-utils diffutils imagemagick openbox xclip xdotool xorg-server-xvfb xorg-xauth && \
    useradd --create-home smoke
COPY arch-preview.sh /usr/local/bin/arch-preview
USER smoke
WORKDIR /home/smoke
CMD ["dbus-run-session", "--", "xvfb-run", "-a", "-s", "-screen 0 1440x960x24", "bash", "/usr/local/bin/arch-preview"]
