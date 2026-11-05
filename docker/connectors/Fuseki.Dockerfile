FROM eclipse-temurin:21-jre
ARG JENA_VERSION=5.6.0
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /fuseki
RUN curl -fsSLo fuseki.jar https://repo.maven.apache.org/maven2/org/apache/jena/jena-fuseki-server/${JENA_VERSION}/jena-fuseki-server-${JENA_VERSION}.jar \
 && curl -fsSLo fuseki.jar.sha1 https://repo.maven.apache.org/maven2/org/apache/jena/jena-fuseki-server/${JENA_VERSION}/jena-fuseki-server-${JENA_VERSION}.jar.sha1 \
 && printf '%s  fuseki.jar\n' "$(cat fuseki.jar.sha1)" | sha1sum -c -
EXPOSE 3030
ENTRYPOINT ["java", "-Xmx512m", "-jar", "/fuseki/fuseki.jar", "--mem", "--update", "/ds"]
