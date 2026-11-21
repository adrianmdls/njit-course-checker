# RDS runs independently of enable_runtime. It can be stopped through AWS,
# but RDS restarts it after about seven days. Storage, backups, snapshots,
# and Secrets Manager can continue to incur charges while it is stopped.
resource "aws_db_subnet_group" "database" {
  name        = "${var.project_name}-db"
  description = "Private subnets for the application database"
  subnet_ids  = aws_subnet.private_db[*].id
}

resource "aws_db_instance" "database" {
  identifier                 = "${var.project_name}-db"
  engine                     = "mariadb"
  engine_version             = "11.8"
  auto_minor_version_upgrade = true
  # The RDS MariaDB 11.8 defaults enforce TLS via require_secure_transport.
  parameter_group_name = "default.mariadb11.8"
  instance_class       = "db.t4g.micro"
  multi_az             = false
  allocated_storage    = 20
  storage_type         = "gp3"
  storage_encrypted    = true
  publicly_accessible  = false

  db_subnet_group_name   = aws_db_subnet_group.database.name
  vpc_security_group_ids = [aws_security_group.database.id]
  db_name                = "njit_course_checker"
  port                   = 3306

  username                    = "dbadmin"
  manage_master_user_password = true
  backup_retention_period     = 7

  # Intentional teardown requires disabling both protections and ensuring
  # the final snapshot identifier is available before deleting the instance.
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.project_name}-db-final"

  lifecycle {
    prevent_destroy = true
  }
}
