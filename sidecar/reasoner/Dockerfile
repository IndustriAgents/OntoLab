# OntoLab DL reasoner sidecar (OWL API 5 + HermiT).
#   docker build -t ontolab-reasoner sidecar/reasoner
#   docker run -p 127.0.0.1:8091:8091 ontolab-reasoner
# Then start the Node server with REASONER_URL=http://localhost:8091
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -q -B dependency:go-offline
COPY src ./src
RUN mvn -q -B package -DskipTests

FROM eclipse-temurin:17-jre
RUN useradd --create-home --uid 10001 app
WORKDIR /app
COPY --from=build /src/target/reasoner.jar /app/reasoner.jar
USER app
ENV PORT=8091 \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75"
EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -q -O - http://127.0.0.1:8091/health >/dev/null 2>&1 || exit 1
CMD ["java", "-jar", "/app/reasoner.jar"]
