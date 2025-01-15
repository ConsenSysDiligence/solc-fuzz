FROM node:20-bookworm AS base

WORKDIR /app

RUN apt-get update && apt-get install -y libboost-all-dev cmake git openssh-client clang-19 make libz3-dev

RUN mkdir -p -m 0700 ~/.ssh && ssh-keyscan github.com >> ~/.ssh/known_hosts

RUN --mount=type=ssh git clone git@github.com:ConsenSysDiligence/evmc-eof.git \
    && cd evmc-eof \
    && cmake . -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=/app/evmc-eof/cmake/cable/toolchains/cxx17.cmake -DEVMC_TESTING=ON -B build \
    && cmake --build build -- -j4

RUN curl -L https://github.com/ethereum/evmone/releases/download/v0.13.0/evmone-0.13.0-linux-x86_64.tar.gz -o evmone.tar.gz \
    && tar -xzf evmone.tar.gz

RUN git clone https://github.com/ipsilon/solidity.git \
    && cd solidity \
    && git checkout block-dedup-eof \
    && mkdir build && cd build && cmake .. -DUSE_Z3=OFF && make

COPY package.json package-lock.json ./

RUN --mount=type=ssh npm install --ignore-scripts

FROM node:20-bookworm-slim AS final

RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*

ENV SOLC_WRAPPER_PATH=/app/solc_wrapper.sh
ENV SOLC_PATH=/usr/bin/solc
ENV EVM_PATH=/usr/lib/libevmone.so.0.13.0
ENV EVMC_PATH=/usr/bin/evmc

WORKDIR /app

RUN set -e && \
    echo 'deb http://deb.debian.org/debian testing main' > /etc/apt/sources.list.d/testing.list && \
    echo 'Package: *\nPin: release a=testing\nPin-Priority: 100' > /etc/apt/preferences.d/testing && \
    apt-get update && \
    apt-get install -y --no-install-recommends -t testing libstdc++6 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=base /app/evmc-eof/build/bin/evmc /usr/bin/evmc
COPY --from=base /app/solidity/build/solc/solc /usr/bin/solc
COPY --from=base /app/node_modules /app/node_modules
COPY --from=base /app/lib/libevmone.so.0.13.0 /usr/lib/libevmone.so.0.13.0

COPY . .

RUN npm link

CMD ["node", "src/bin/solc-fuzz.ts"]
