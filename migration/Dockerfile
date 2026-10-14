FROM python:3.12-slim
RUN pip install --no-cache-dir 'psycopg[binary]==3.2.10'
COPY migrate.py /migrate.py
CMD ["python", "/migrate.py"]
