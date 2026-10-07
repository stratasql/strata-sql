# Strata SQL in Docker: the npm package `@stratasql/strata-sql` served over HTTP (the browser editor), with your project folder mounted at /data.
# The image never copies this repository: it installs the published package, so the npm and Docker builds are the same code by construction.
#   docker run --rm -v "$PWD":/data strata-sql init --template northwind     # create a project in the current folder
#   docker run --rm -v "$PWD":/data -p 127.0.0.1:8787:8787 strata-sql        # open http://localhost:8787/?t=<token from the log>
#   docker run --rm -p 127.0.0.1:8787:8787 -e STRATA_DEMO=1 strata-sql                              # the demo: sample models to explore, nothing mounted, nothing saved
# From this repository's source instead of npm: docker build -f docker/Dockerfile.source -t strata-sql .   (see docker/Dockerfile.source)
# Build:  docker build -t strata-sql --build-arg PACKAGE=@stratasql/strata-sql@<version> docker
# Before the package is published, test with the tarball: put it in docker/pkg/ and use --build-arg PACKAGE=/pkg/stratasql-strata-sql-<version>.tgz (scripts/check-builds.js does).
FROM node:22-alpine
ARG PACKAGE=@stratasql/strata-sql
ARG VERSION=dev
LABEL org.opencontainers.image.title="Strata SQL" \
      org.opencontainers.image.description="Model, govern and version your data: the Strata SQL editor in your browser" \
      org.opencontainers.image.url="https://stratasql.com" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
# the tarball (if any) is mounted for this one step, so it is not kept in a layer
RUN --mount=type=bind,source=pkg,target=/pkg npm install -g --omit=dev --no-audit --no-fund "${PACKAGE}" && npm cache clean --force
WORKDIR /data
VOLUME /data
# not root: on Linux, run with --user "$(id -u):$(id -g)" if the mounted folder belongs to someone else
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1:8787/media/brand.js || exit 1
ENTRYPOINT ["strata-sql"]
# listens on all interfaces INSIDE the container; publish the port to localhost only (-p 127.0.0.1:8787:8787). STRATA_TOKEN keeps the link stable.
CMD ["live", "--host", "0.0.0.0", "--port", "8787", "--no-open"]
