FROM mcr.microsoft.com/playwright:v1.61.1-noble

# The base image's default user has no writable home, and Chromium needs one.
ENV HOME=/tmp \
    XDG_CONFIG_HOME=/tmp \
    XDG_CACHE_HOME=/tmp \
    NODE_ENV=production \
    GAME_DIR=/game \
    MODS_DIR=/mods \
    MODS_SEED_DIR=/mods-seed \
    PROFILE_DIR=/profile \
    SAVES_DIR=/saves

WORKDIR /app
COPY app/ /app/

EXPOSE 3000

CMD ["node", "sidecar.mjs"]
